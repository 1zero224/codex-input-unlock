[CmdletBinding()]
param(
  [string]$BundlePath,
  [switch]$SkipPackageCheck
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$controller = Join-Path $repo 'codex-input-unlock.ps1'
$supervisor = Join-Path $repo 'cdp-supervisor.mjs'
$gate = Join-Path $repo 'quota-gate.cjs'

foreach ($script in @($controller, $PSCommandPath)) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw "PowerShell parse failed for $script`: $($errors[0].Message)" }
}

& node --check $supervisor
if ($LASTEXITCODE -ne 0) { throw 'cdp-supervisor.mjs failed node --check' }
$supervisorText = Get-Content -LiteralPath $supervisor -Raw -Encoding UTF8
if ($supervisorText -match 'Debugger\.setBreakpoint[\s\S]{0,300}\blocation:\s*actualLocation,\s*\r?\n\s*condition,') {
  throw 'supervisor uses an undefined shorthand breakpoint condition'
}
& node --check $gate
if ($LASTEXITCODE -ne 0) { throw 'quota-gate.cjs failed node --check' }

$gateApiText = & node -e "const gate=require(process.argv[1]); const condition=gate.condition({mode:'codex-local-quota',quotaVariable:'quota'}); console.log(JSON.stringify({locate:typeof gate.locate,conditionType:typeof gate.condition,condition}));" $gate
if ($LASTEXITCODE -ne 0) { throw 'quota-gate.cjs API probe failed' }
$gateApi = $gateApiText | ConvertFrom-Json
if ($gateApi.locate -ne 'function' -or $gateApi.conditionType -ne 'function') { throw 'quota gate API is incomplete' }
if ($gateApi.condition -ne '(quota=false,false)') { throw 'quota gate condition contains unexpected extra logic' }

if (-not $SkipPackageCheck) {
  $configPath = Join-Path $env:USERPROFILE '.codex\config.toml'
  $configHashBefore = if (Test-Path -LiteralPath $configPath -PathType Leaf) { (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash } else { $null }
  $diagnosisText = & pwsh -NoProfile -ExecutionPolicy Bypass -File $controller -Action Diagnose | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'Diagnose failed' }
  $configHashAfter = if (Test-Path -LiteralPath $configPath -PathType Leaf) { (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash } else { $null }
  if ($configHashBefore -ne $configHashAfter) { throw 'Diagnose modified config.toml' }
}

$controllerText = Get-Content -LiteralPath $controller -Raw -Encoding UTF8
$forbiddenConfigMutationMarkers = @(
  'Enable-ProviderOpenAIAuth',
  'Restore-ConfigIfUnchanged',
  'configBackupPath',
  'patchedConfigHash',
  'configRestoreEligible',
  'Write-Utf8NoBom $Provider.ConfigPath',
  '[System.IO.File]::Copy($Provider.ConfigPath'
)
foreach ($marker in $forbiddenConfigMutationMarkers) {
  if ($controllerText.Contains($marker, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Controller still contains a forbidden config mutation path: $marker"
  }
}
if ($controllerText -notmatch 'configManagedByPatch\s*=\s*\$false') {
  throw 'Controller does not declare config.toml as user-managed'
}
if ($controllerText -notmatch 'function Test-StablePwshPath') {
  throw 'Controller does not distinguish version-pinned Store pwsh paths from stable ones'
}
if ($controllerText -match "Source\s+-notlike\s+'\*\\WindowsApps") {
  throw 'Controller rejects every Store pwsh path instead of only the version-pinned ones'
}
if ($controllerText -notmatch 'function Get-RunningOpenAIDesktopProcesses') {
  throw 'Controller does not scan all supported Codex and ChatGPT Desktop packages before launch'
}
if ($controllerText -notmatch '-Action Launch -PauseOnError') {
  throw 'Shortcut launch does not preserve the error window'
}
if ($controllerText -notmatch 'Launch blocked because Codex or ChatGPT Desktop is still running') {
  throw 'Controller does not provide the expected English running-app error'
}
if ($controllerText -notmatch 'Press Enter to close this window') {
  throw 'Controller does not provide an English close-window prompt'
}

if ($BundlePath) {
  $selfTestText = & node $supervisor --self-test --gate $gate --bundle $BundlePath
  if ($LASTEXITCODE -ne 0) { throw 'Quota gate current-bundle self-test failed' }
  $selfTest = $selfTestText | ConvertFrom-Json
  if ($selfTest.location.mode -notin @('codex-local-quota', 'local-submit-quota')) { throw 'Current bundle did not use a supported Codex local quota locator' }
  if (-not $selfTest.location.quotaVariable) {
    throw 'Current bundle locator did not identify the local quota variable'
  }
  if ($selfTest.location.mode -eq 'codex-local-quota' -and -not $selfTest.location.hostVariable) {
    throw 'Current bundle locator did not identify the local host variable'
  }
  if ($selfTest.condition -notmatch '^\([A-Za-z_$][\w$]*=false,false\)$') {
    throw 'Current bundle locator produced an unexpected breakpoint condition'
  }
  if ($null -eq $selfTest.location.endLineNumber -or $null -eq $selfTest.location.endColumnNumber) {
    throw 'Current bundle locator did not bound the quota expression'
  }
}

Write-Host 'codex-input-unlock smoke tests passed'
