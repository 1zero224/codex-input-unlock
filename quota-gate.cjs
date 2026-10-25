/*
 * Runtime quota gate for Codex Desktop.
 *
 * The injected API locates the minified composer quota predicate and builds a
 * conditional CDP breakpoint which clears only the located quota variable.
 */
(() => {
  const identifier = "[A-Za-z_$][\\w$]*";

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function sourceLocation(
    source,
    sourceUrl,
    absoluteOffset,
    quotaVariable,
    hostVariable,
    mode,
    conversationQuotaVariable = null,
    endOffset = null,
  ) {
    const precedingLines = source.slice(0, absoluteOffset).split("\n");
    const result = {
      urlRegex: `^${escapeRegex(sourceUrl)}$`,
      lineNumber: precedingLines.length - 1,
      columnNumber: precedingLines.at(-1).length,
      quotaVariable,
      hostVariable: hostVariable || null,
      conversationQuotaVariable: conversationQuotaVariable || null,
      mode,
    };
    if (Number.isInteger(endOffset) && endOffset > absoluteOffset) {
      const endLines = source.slice(0, endOffset).split("\n");
      result.endLineNumber = endLines.length - 1;
      result.endColumnNumber = endLines.at(-1).length;
    }
    return result;
  }

  function locateLegacy(source, sourceUrl, atomVariable) {
    const localGatePattern = new RegExp(
      `(${identifier})=${identifier}\\(${escapeRegex(atomVariable)}\\)&&(${identifier})===\\\`local\\\``,
      "g",
    );
    const localGates = [...source.matchAll(localGatePattern)];
    if (localGates.length !== 1) return null;

    const gate = localGates[0];
    const tailOffset = gate.index + gate[0].length;
    const tail = source.slice(tailOffset, tailOffset + 18000);
    const assignment = new RegExp(
      `(${identifier})=(${identifier}(?:\\|\\|${identifier})*\\|\\|${escapeRegex(gate[1])})(?=[,;])`,
    ).exec(tail);
    if (!assignment || !tail.includes(`submitDisabled:${assignment[1]}`)) return null;
    const absoluteOffset = tailOffset + assignment.index + assignment[1].length + 1;
    return sourceLocation(source, sourceUrl, absoluteOffset, gate[1], gate[2], "legacy-local-host");
  }

  function locateModern(source, sourceUrl, atomVariable) {
    const consumerPattern = new RegExp(
      `(${identifier})=${identifier}\\(${escapeRegex(atomVariable)}\\)&&(${identifier})`,
      "g",
    );
    const candidates = [];
    for (const match of source.matchAll(consumerPattern)) {
      const window = source.slice(match.index, match.index + 60000);
      const quota = match[1];
      if (!window.includes("submitDisabled:")) continue;
      if (!window.includes("rateLimitSendBlocked:")) continue;
      const propsPattern = new RegExp(
        `rateLimitSendBlocked:(${identifier})\\|\\|${escapeRegex(quota)},rateLimitConversationSendBlocked:\\1(?:[,}])`,
      );
      const props = propsPattern.exec(window);
      if (!props) continue;
      candidates.push({ match, props });
    }
    if (candidates.length !== 1) return null;
    const { match, props } = candidates[0];
    return sourceLocation(
      source,
      sourceUrl,
      match.index + props.index,
      match[1],
      null,
      "third-party-composer-dual",
      props[1],
    );
  }

  function locateCodexLocalQuota(source, sourceUrl, atomVariable) {
    const consumerPattern = new RegExp(
      `(${identifier})=${identifier}\\(${escapeRegex(atomVariable)}\\)&&(${identifier})===\\\`local\\\``,
      "g",
    );
    const candidates = [];
    for (const consumer of source.matchAll(consumerPattern)) {
      const quota = consumer[1];
      const window = source.slice(consumer.index, consumer.index + 12000);
      const assignmentPattern = new RegExp(
        `let (${identifier})=([^,;]{1,900}\\|\\|${escapeRegex(quota)}),(${identifier});`,
      );
      const assignment = assignmentPattern.exec(window);
      if (!assignment) continue;
      if (!window.slice(assignment.index, assignment.index + 10000).includes(`submitDisabled:${assignment[1]}`)) continue;
      const absoluteStart = consumer.index + assignment.index;
      const absoluteEnd = absoluteStart + assignment[0].lastIndexOf(`,${assignment[3]};`);
      candidates.push({ consumer, absoluteStart, absoluteEnd });
    }
    if (candidates.length !== 1) return null;
    const candidate = candidates[0];
    return sourceLocation(
      source,
      sourceUrl,
      candidate.absoluteStart,
      candidate.consumer[1],
      candidate.consumer[2],
      "codex-local-quota",
      null,
      candidate.absoluteEnd,
    );
  }

  function locateComposerQuotaConsumer(source, sourceUrl, atomVariable) {
    const readPattern = new RegExp(
      `(${identifier})=${identifier}\\(${identifier}\\?${escapeRegex(atomVariable)}:(?:!1|false)\\)`,
      "g",
    );
    const reads = [...source.matchAll(readPattern)];
    if (reads.length === 0) return null;
    const candidates = new Map();
    for (const read of reads) {
      const quotaVariable = read[1];
      const tailStart = read.index;
      const tail = source.slice(tailStart, tailStart + 60000);
      const consumerPattern = new RegExp(
        `(${identifier})=([^,;]{0,1600}?)\\|\\|${escapeRegex(quotaVariable)}\\|\\|`,
        "g",
      );
      for (const consumer of tail.matchAll(consumerPattern)) {
        const absoluteStart = tailStart + consumer.index;
        if (candidates.has(absoluteStart)) continue;
        const window = source.slice(absoluteStart, absoluteStart + 40000);
        if (!window.includes("submitDisabled:")) continue;
        candidates.set(absoluteStart, {
          absoluteStart,
          quotaVariable,
          quotaOffset: absoluteStart + consumer[1].length + 1 + consumer[2].length + 2,
        });
      }
    }
    if (candidates.size !== 1) return null;
    const candidate = [...candidates.values()][0];
    return sourceLocation(
      source,
      sourceUrl,
      candidate.absoluteStart,
      candidate.quotaVariable,
      null,
      "composer-quota-consumer",
      null,
      candidate.quotaOffset,
    );
  }

  function locateQuotaAtomGuard(source, sourceUrl, atomVariable) {
    const guardPattern = new RegExp(
      `${escapeRegex(atomVariable)}=${identifier}\\(${identifier},\\(\\{get:${identifier}\\}\\)=>\\{([^}]{0,3000}?)(${identifier})\\??\\.rate_limit\\??\\.allowed!==(?:!1|false)`,
      "d",
    );
    const guard = guardPattern.exec(source);
    if (!guard) return null;
    const dataVariable = guard[2];
    const quotaReadOffset = guard.indices[2][0];
    const arrow = guard[0].indexOf("=>");
    const brace = arrow < 0 ? -1 : guard[0].indexOf("{", arrow);
    if (brace < 0) return null;
    const bodyStart = guard.index + brace + 1;
    if (bodyStart >= quotaReadOffset) return null;

    const before = source.slice(bodyStart, quotaReadOffset);
    const ifPattern = /\bif\s*\(/g;
    let ifIndex = -1;
    let candidate;
    while ((candidate = ifPattern.exec(before)) !== null) {
      const absolute = bodyStart + candidate.index;
      if (source.slice(absolute, quotaReadOffset).includes(".authMethod!==")) {
        ifIndex = absolute;
        break;
      }
    }
    if (ifIndex < 0) return null;
    return sourceLocation(
      source,
      sourceUrl,
      ifIndex,
      dataVariable,
      null,
      "quota-atom-data",
      null,
      quotaReadOffset,
    );
  }

  function locateLocalSubmit(source, sourceUrl, atomVariable) {
    const consumerPattern = new RegExp(
      `(${identifier})=${identifier}\\((?:[^()]{0,200}?&&\\s*)?${escapeRegex(atomVariable)}\\)`,
      "g",
    );
    const candidates = [];
    for (const consumer of source.matchAll(consumerPattern)) {
      const quotaVariable = consumer[1];
      const tail = source.slice(consumer.index, consumer.index + 20000);
      const blockPattern = new RegExp(
        `(${identifier})=[^;]{0,8000}?\\|\\|${escapeRegex(quotaVariable)}(?=[,;)|])`,
        "g",
      );
      for (const block of tail.matchAll(blockPattern)) {
        const blockVariable = block[1];
        const absoluteStart = consumer.index + block.index;
        const window = source.slice(absoluteStart, absoluteStart + 12000);
        if (!window.includes(`submitDisabled:${blockVariable}`)) continue;
        const equals = source.indexOf("=", absoluteStart);
        if (equals < 0) continue;
        let start = equals + 1;
        while (start < source.length && /\s/.test(source[start])) start += 1;
        candidates.push({ quotaVariable, start });
      }
    }
    if (candidates.length !== 1) return null;
    const candidate = candidates[0];
    return sourceLocation(
      source,
      sourceUrl,
      candidate.start,
      candidate.quotaVariable,
      null,
      "local-submit-quota",
      null,
      candidate.start + 1,
    );
  }

  function atomPattern() {
    return new RegExp(
      `(${identifier})=${identifier}\\(${identifier},\\(\\{get:${identifier}\\}\\)=>\\{[^}]{0,1400}?\\.authMethod!==\\\`chatgpt\\\`[^}]{0,1400}?\\??\\.rate_limit\\??\\.allowed!==(?:!1|false)`,
      "g",
    );
  }

  function locateAll(source, sourceUrl) {
    if (typeof source !== "string" || source.length === 0) return [];
    if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return [];
    const atoms = [...source.matchAll(atomPattern())];
    if (atoms.length !== 1) return [];
    const atomVariable = atoms[0][1];
    const locators = [
      locateCodexLocalQuota,
      locateLegacy,
      locateModern,
      locateLocalSubmit,
      locateComposerQuotaConsumer,
      locateQuotaAtomGuard,
    ];
    const results = [];
    for (const locator of locators) {
      let location = null;
      try { location = locator(source, sourceUrl, atomVariable); } catch {}
      if (!location) continue;
      const condition = conditionForLocation(location);
      if (!condition) continue;
      const duplicate = results.some((entry) =>
        entry.location.lineNumber === location.lineNumber
        && entry.location.columnNumber === location.columnNumber
        && entry.location.urlRegex === location.urlRegex);
      if (duplicate) continue;
      results.push({ location, condition });
    }
    return results;
  }

  function locate(source, sourceUrl) {
    const matches = locateAll(source, sourceUrl);
    return matches.length > 0 ? matches[0].location : null;
  }

  function explain(source, sourceUrl) {
    const report = { atomCount: 0, submitDisabled: false, matched: [] };
    if (typeof source !== "string" || source.length === 0) return report;
    const atoms = [...source.matchAll(atomPattern())];
    report.atomCount = atoms.length;
    report.submitDisabled = source.includes("submitDisabled:");
    report.matched = locateAll(source, sourceUrl).map((entry) => entry.location.mode);
    return report;
  }

  const stats = { unlockCount: 0, lastUnlockOk: null };

  function unlock(data) {
    try {
      const rateLimit = data?.rate_limit;
      if (rateLimit == null || typeof rateLimit !== "object") return false;
      if (rateLimit.allowed === true) {
        stats.unlockCount += 1;
        stats.lastUnlockOk = true;
        return true;
      }
      try { rateLimit.allowed = true; } catch {}
      if (rateLimit.allowed === true) {
        stats.unlockCount += 1;
        stats.lastUnlockOk = true;
        return true;
      }
      try {
        if (Object.isExtensible(data)) data.rate_limit = { ...rateLimit, allowed: true };
      } catch {}
      const ok = data.rate_limit?.allowed === true;
      stats.unlockCount += 1;
      stats.lastUnlockOk = ok;
      return ok;
    } catch {
      stats.unlockCount += 1;
      stats.lastUnlockOk = false;
      return false;
    }
  }

  function conditionForLocation(location) {
    const safeIdentifier = /^[A-Za-z_$][\w$]*$/;
    if (!safeIdentifier.test(location?.quotaVariable || "")) return null;
    const quota = location.quotaVariable;
    if (
      location.mode === "codex-local-quota"
      || location.mode === "legacy-local-host"
      || location.mode === "local-submit-quota"
      || location.mode === "composer-quota-consumer"
    ) {
      return `(${quota}=false,false)`;
    }
    if (location.mode === "quota-atom-data") {
      return `(__codexExternalQuotaGate.unlock(${quota}),false)`;
    }
    if (location.mode === "third-party-composer-dual") {
      if (!safeIdentifier.test(location.conversationQuotaVariable || "")) return null;
      return `(${location.conversationQuotaVariable}=false,${quota}=false,false)`;
    }
    return null;
  }

  const api = { locate, locateAll, condition: conditionForLocation, explain, unlock, stats };
  globalThis.__codexExternalQuotaGate = api;
  if (typeof module === "object" && module?.exports) module.exports = api;
})();
