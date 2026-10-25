import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function writeJsonAtomic(filePath, value) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.rmSync(filePath, { force: true });
  fs.renameSync(temp, filePath);
}

function status(state, extra = {}) {
  writeJsonAtomic(args.status, {
    state,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid CDP port: ${value}`);
  }
  return port;
}

function validateWebSocketUrl(value, expectedPort) {
  const parsed = new URL(value);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`unexpected websocket scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`CDP websocket is not loopback-only: ${parsed.hostname}`);
  }
  if (Number(parsed.port) !== expectedPort) {
    throw new Error(`CDP websocket port mismatch: ${parsed.port}`);
  }
  return parsed.toString();
}

async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function targetRank(target) {
  if (target?.type !== "page") return -1;
  const url = String(target.url || "");
  if (url === "app://-/index.html") return 100;
  if (url.startsWith("app://")) return 80;
  return -1;
}

async function discoverTarget(port) {
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  } catch (firstError) {
    try {
      targets = await fetchJson(`http://[::1]:${port}/json`);
    } catch {
      throw firstError;
    }
  }
  if (!Array.isArray(targets)) throw new Error("CDP target list is not an array");
  const ranked = targets
    .map((target) => ({ target, rank: targetRank(target) }))
    .filter((entry) => entry.rank >= 0 && entry.target.webSocketDebuggerUrl)
    .sort((left, right) => right.rank - left.rank);
  if (ranked.length === 0) throw new Error("Codex renderer target not found");
  const selected = ranked[0].target;
  return {
    ...selected,
    webSocketDebuggerUrl: validateWebSocketUrl(selected.webSocketDebuggerUrl, port),
  };
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect(timeoutMs = 5000) {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        try { this.socket?.close(); } catch {}
        finish(reject, new Error("CDP websocket open timed out"));
      }, timeoutMs);
      this.socket.addEventListener("open", () => finish(resolve), { once: true });
      this.socket.addEventListener("error", () => {
        try { this.socket?.close(); } catch {}
        finish(reject, new Error("CDP websocket failed to open"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => void this.onMessage(event.data));
    this.socket.addEventListener("close", () => this.rejectPending(new Error("CDP websocket closed")));
  }

  async onMessage(data) {
    let text;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    else if (typeof data?.text === "function") text = await data.text();
    else return;

    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (!message.id) {
      if (message.method) {
        for (const handler of this.eventHandlers.get(message.method) || []) {
          try { handler(message.params || {}); } catch {}
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result || {});
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 7000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP websocket is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
    this.eventHandlers.get(method).add(handler);
    return () => this.eventHandlers.get(method)?.delete(handler);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error("renderer evaluation failed");
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

function buildBootstrap(location, bundleUrl) {
  const serializedLocation = JSON.stringify({ ...location, condition: location.condition });
  const serializedBundleUrl = JSON.stringify(bundleUrl);
  return `(() => {
    globalThis.__codexInputUnlockState = {
      status: "located",
      bundleUrl: ${serializedBundleUrl},
      breakpoint: ${serializedLocation},
    };
    globalThis.__codexExternalPatchState = globalThis.__codexInputUnlockState;
  })();`;
}

async function installScripts(session, combinedSource) {
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  let installed;
  try {
    installed = await session.send("Page.addScriptToEvaluateOnNewDocument", { source: combinedSource, runImmediately: true });
  } catch {
    installed = await session.send("Page.addScriptToEvaluateOnNewDocument", { source: combinedSource });
  }
  await session.evaluate(combinedSource);
  const verified = await session.evaluate("Boolean(globalThis.__codexExternalQuotaGate && (globalThis.__codexInputUnlockState?.breakpoint || globalThis.__codexExternalPatchState?.breakpoint))");
  if (verified !== true) throw new Error("renderer runtime injection did not verify");
  return installed.identifier || null;
}

function isCandidateScriptUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "app:" && parsed.pathname.endsWith(".js");
  } catch {
    return false;
  }
}

async function waitForQuotaScript(session, gateApi, timeoutMs = 20000) {
  let removeHandler = null;
  let settled = false;
  let parsedScripts = 0;
  let candidateScripts = 0;
  let lastProbe = null;
  try {
    const scriptPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const detail = JSON.stringify({ parsedScripts, candidateScripts, lastProbe });
        reject(new Error(`quota bundle discovery timed out (${detail})`));
      }, timeoutMs);
      removeHandler = session.on("Debugger.scriptParsed", (params) => {
        parsedScripts += 1;
        if (settled || !params.scriptId || !isCandidateScriptUrl(params.url)) return;
        candidateScripts += 1;
        void (async () => {
          try {
            const sourceResult = await session.send("Debugger.getScriptSource", { scriptId: params.scriptId }, 15000);
            const source = sourceResult.scriptSource;
            if (typeof source !== "string" || source.length === 0) return;
            let breakpoints = [];
            if (typeof gateApi.locateAll === "function") {
              breakpoints = gateApi.locateAll(source, params.url).slice(0, 4);
            } else {
              const location = gateApi.locate(source, params.url);
              const condition = gateApi.condition(location);
              if (location && condition) breakpoints = [{ location, condition }];
            }
            if (breakpoints.length === 0) {
              if (typeof gateApi.explain === "function") {
                try { lastProbe = { url: params.url, ...gateApi.explain(source, params.url) }; } catch {}
              }
              return;
            }
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ scriptId: params.scriptId, url: params.url, breakpoints });
          } catch {}
        })();
      });
    });
    await session.send("Debugger.enable", {}, timeoutMs);
    return await scriptPromise;
  } finally {
    removeHandler?.();
  }
}

async function resolveBreakpointLocation(session, scriptId, desired) {
  if (Number.isInteger(desired.endLineNumber) && Number.isInteger(desired.endColumnNumber)) {
    const start = {
      scriptId,
      lineNumber: desired.lineNumber,
      columnNumber: desired.columnNumber,
    };
    const end = {
      scriptId,
      lineNumber: desired.endLineNumber,
      columnNumber: desired.endColumnNumber,
    };
    const result = await session.send("Debugger.getPossibleBreakpoints", { start, end, restrictToFunction: true });
    const candidates = (result.locations || [])
      .filter((item) => {
        if (item.scriptId !== scriptId) return false;
        if (item.lineNumber < start.lineNumber || item.lineNumber > end.lineNumber) return false;
        if (item.lineNumber === start.lineNumber && item.columnNumber < start.columnNumber) return false;
        if (item.lineNumber === end.lineNumber && item.columnNumber > end.columnNumber) return false;
        return true;
      })
      .sort((left, right) => left.lineNumber - right.lineNumber || left.columnNumber - right.columnNumber);
    if (candidates.length > 0) return candidates[0];
    throw new Error(
      `no executable breakpoint inside quota expression ${start.lineNumber}:${start.columnNumber}-${end.lineNumber}:${end.columnNumber}`,
    );
  }
  for (const radius of [300, 2000]) {
    const start = {
      scriptId,
      lineNumber: desired.lineNumber,
      columnNumber: Math.max(0, desired.columnNumber - 100),
    };
    const end = {
      scriptId,
      lineNumber: desired.lineNumber,
      columnNumber: desired.columnNumber + radius,
    };
    const result = await session.send("Debugger.getPossibleBreakpoints", { start, end, restrictToFunction: true });
    const candidates = (result.locations || [])
      .filter((item) => item.scriptId === scriptId && item.lineNumber === desired.lineNumber && item.columnNumber >= desired.columnNumber)
      .sort((left, right) => left.columnNumber - right.columnNumber);
    if (candidates.length > 0) return candidates[0];
  }
  throw new Error(`no executable breakpoint location at or after ${desired.lineNumber}:${desired.columnNumber}`);
}

async function superviseTarget(target, gateSource, gateApi, port, onReady) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  const armedBreakpoints = [];
  let documentScriptId = null;
  let removeReloadHandler = null;
  try {
    await session.connect();
    const script = await waitForQuotaScript(session, gateApi);
    const primary = script.breakpoints[0];
    const bootstrap = buildBootstrap({ ...primary.location, condition: primary.condition }, script.url);
    documentScriptId = await installScripts(session, `${gateSource}\n${bootstrap}`);
    for (const candidate of script.breakpoints) {
      try {
        const actualLocation = await resolveBreakpointLocation(session, script.scriptId, candidate.location);
        const armed = await session.send("Debugger.setBreakpoint", {
          location: actualLocation,
          condition: candidate.condition,
        });
        if (!armed.breakpointId || !armed.actualLocation) continue;
        armedBreakpoints.push({
          mode: candidate.location.mode,
          breakpointId: armed.breakpointId,
          requestedLocation: {
            lineNumber: candidate.location.lineNumber,
            columnNumber: candidate.location.columnNumber,
          },
          actualLocation: armed.actualLocation,
        });
      } catch (error) {
        process.stderr.write(`[skip-breakpoint] ${candidate.location.mode}: ${error.message}\n`);
      }
    }
    if (armedBreakpoints.length === 0) throw new Error("Debugger.setBreakpoint did not resolve an actual location");
    const armedPrimary = armedBreakpoints[0];
    const readyDetails = {
      port,
      targetId: target.id,
      targetUrl: target.url,
      bundleUrl: script.url,
      breakpointId: armedPrimary.breakpointId,
      requestedLocation: armedPrimary.requestedLocation,
      actualLocation: armedPrimary.actualLocation,
      breakpoints: armedBreakpoints,
    };
    status("ready", readyDetails);
    onReady?.();

    let reloadDetected = false;
    removeReloadHandler = session.on("Runtime.executionContextsCleared", () => { reloadDetected = true; });
    while (true) {
      await sleep(2000);
      if (reloadDetected) return;
      const probe = await session.evaluate("(() => ({ alive: Boolean(globalThis.__codexExternalQuotaGate && (globalThis.__codexInputUnlockState?.breakpoint || globalThis.__codexExternalPatchState?.breakpoint)), stats: globalThis.__codexExternalQuotaGate?.stats ?? null }))()");
      if (probe?.alive !== true) return;
      status("ready", { ...readyDetails, gateStats: probe.stats });
    }
  } finally {
    removeReloadHandler?.();
    for (const armed of armedBreakpoints) {
      try { await session.send("Debugger.removeBreakpoint", { breakpointId: armed.breakpointId }, 2000); } catch {}
    }
    if (documentScriptId) {
      try {
        await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: documentScriptId }, 2000);
      } catch {}
    }
    session.close();
  }
}

async function selfTest() {
  const gatePath = path.resolve(String(args.gate || ""));
  const bundlePath = path.resolve(String(args.bundle || ""));
  if (!fs.existsSync(gatePath)) throw new Error(`gate file missing: ${gatePath}`);
  if (!fs.existsSync(bundlePath)) throw new Error(`bundle file missing: ${bundlePath}`);
  delete require.cache[gatePath];
  const gate = require(gatePath);
  const source = fs.readFileSync(bundlePath, "utf8");
  const sourceUrl = `app://-/assets/${path.basename(bundlePath)}`;
  const location = gate.locate(source, sourceUrl);
  const condition = gate.condition(location);
  const explain = typeof gate.explain === "function" ? gate.explain(source, sourceUrl) : null;
  if (!location || !condition) {
    throw new Error(`quota gate did not uniquely locate the current bundle: ${JSON.stringify(explain)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, location, condition, explain })}\n`);
}

async function main() {
  if (args["self-test"]) {
    await selfTest();
    return;
  }

  const port = validatePort(args.port);
  if (!args.gate || !args.status) throw new Error("--gate and --status are required");
  const gateSource = fs.readFileSync(args.gate, "utf8");
  delete require.cache[path.resolve(args.gate)];
  const gateApi = require(path.resolve(args.gate));
  const startupTimeoutMs = Number(args["startup-timeout"] || 60) * 1000;
  const deadline = Date.now() + startupTimeoutMs;
  let everReady = false;
  let missingSince = null;
  let lastRetryError = null;
  status("waiting-for-codex", { port });

  while (true) {
    let target;
    try {
      target = await discoverTarget(port);
      missingSince = null;
    } catch (error) {
      if (!missingSince) missingSince = Date.now();
      if (!everReady && Date.now() >= deadline) throw new Error(`Codex CDP startup timed out: ${error.message}`);
      if (everReady && Date.now() - missingSince > 20000) return;
      await sleep(500);
      continue;
    }

    status("injecting", { port, targetId: target.id, targetUrl: target.url, lastError: lastRetryError });
    try {
      await superviseTarget(target, gateSource, gateApi, port, () => { everReady = true; });
    } catch (error) {
      if (!everReady && Date.now() >= deadline) throw error;
      lastRetryError = error?.stack || error?.message || String(error);
      status("retrying", { port, error: lastRetryError });
      process.stderr.write(`[retry] ${lastRetryError}\n`);
      await sleep(1000);
    }
  }
}

main().catch((error) => {
  status("failed", { error: error?.stack || String(error) });
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
