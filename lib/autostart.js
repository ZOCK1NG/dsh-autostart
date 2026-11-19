import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SHORTCUT_NAME = 'DeepSeek Harness.lnk'
const EXE_PLACEHOLDER = '__DSH_EXE_PATH__'
const PAYLOAD_DIR = fileURLToPath(new URL('../payload/', import.meta.url))

const CREATE_SHORTCUT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$startupDir = Split-Path -Parent $env:DSH_AUTOSTART_SHORTCUT
if (-not (Test-Path -LiteralPath $startupDir)) { New-Item -ItemType Directory -Path $startupDir -Force | Out-Null }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:DSH_AUTOSTART_SHORTCUT)
$shortcut.TargetPath = (Join-Path $env:WINDIR 'System32\wscript.exe')
$shortcut.Arguments = '//B //Nologo "' + $env:DSH_AUTOSTART_VBS + '"'
$shortcut.WorkingDirectory = $env:DSH_AUTOSTART_INSTALL_DIR
$shortcut.IconLocation = $env:DSH_AUTOSTART_APP + ',0'
$shortcut.Description = 'DeepSeek Harness (starts in the system tray)'
$shortcut.Save()
Write-Output 'ok'
`.trim()

const READ_SHORTCUT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ exists = (Test-Path -LiteralPath $env:DSH_AUTOSTART_SHORTCUT); target = ''; arguments = ''; workingDirectory = ''; icon = '' }
if ($result.exists) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($env:DSH_AUTOSTART_SHORTCUT)
  $result.target = $shortcut.TargetPath
  $result.arguments = $shortcut.Arguments
  $result.workingDirectory = $shortcut.WorkingDirectory
  $result.icon = $shortcut.IconLocation
}
$result | ConvertTo-Json -Compress
`.trim()

const ENABLE_APPROVAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
$name = $env:DSH_AUTOSTART_SHORTCUT_NAME
if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
$enabled = [byte[]](2,0,0,0,0,0,0,0,0,0,0,0)
$existing = Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
if ($null -eq $existing) {
  New-ItemProperty -Path $key -Name $name -Value $enabled -PropertyType Binary | Out-Null
} else {
  $bytes = $existing.$name
  if ($null -eq $bytes -or $bytes.Length -lt 1 -or $bytes[0] -ne 2) {
    Set-ItemProperty -Path $key -Name $name -Value $enabled -PropertyType Binary
  }
}
Write-Output 'ok'
`.trim()

const DISABLE_APPROVAL_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
Remove-ItemProperty -Path $key -Name $env:DSH_AUTOSTART_SHORTCUT_NAME -ErrorAction SilentlyContinue
Write-Output 'ok'
`.trim()

const INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
$name = $env:DSH_AUTOSTART_SHORTCUT_NAME
$value = Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
$approval = 'absent'
if ($null -ne $value) {
  if (($value.$name)[0] -eq 2) { $approval = 'enabled' } else { $approval = 'disabled' }
}
$policy = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction SilentlyContinue
$smartAppControl = 'unknown'
if ($null -ne $policy) {
  if ($policy.VerifiedAndReputablePolicyState -eq 1) { $smartAppControl = 'enforced' } else { $smartAppControl = 'off' }
}
[ordered]@{ approval = $approval; smartAppControl = $smartAppControl } | ConvertTo-Json -Compress
`.trim()

function computePaths(options = {}) {
  if (process.platform !== 'win32') throw new Error('dsh-autostart only supports Windows (win32).')
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const installDir = options.installDir || join(localAppData, 'DSH')
  const startupDir = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  const shortcutName = options.shortcutName || SHORTCUT_NAME
  return {
    installDir,
    startupDir,
    shortcut: join(startupDir, shortcutName),
    shortcutName,
    ps1: join(installDir, 'dsh-tray-start.ps1'),
    vbs: join(installDir, 'dsh-tray-start.vbs'),
    logPath: join(installDir, 'tray-start.log'),
    appPath: options.appPath || process.execPath,
  }
}

function escapePowerShellLiteral(value) {
  return String(value).replaceAll("'", "''")
}

function runPowerShell(script, environment = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return {
    status: result.status === null ? -1 : result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error ? String(result.error.message || result.error) : '',
  }
}

function readShortcut(paths) {
  const result = runPowerShell(READ_SHORTCUT_SCRIPT, { DSH_AUTOSTART_SHORTCUT: paths.shortcut })
  if (result.status !== 0) throw new Error(`Could not read the startup shortcut: ${result.stderr || result.stdout || result.error}`)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`Unexpected shortcut inspection output: ${result.stdout || result.stderr}`)
  }
}

function readInspectState(paths) {
  const result = runPowerShell(INSPECT_SCRIPT, { DSH_AUTOSTART_SHORTCUT_NAME: paths.shortcutName })
  if (result.status !== 0) return { approval: 'unknown', smartAppControl: 'unknown' }
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { approval: 'unknown', smartAppControl: 'unknown' }
  }
}

function deployLauncher(paths) {
  mkdirSync(paths.installDir, { recursive: true })
  const template = readFileSync(join(PAYLOAD_DIR, 'dsh-tray-start.ps1'), 'utf8')
  if (!template.includes(EXE_PLACEHOLDER)) throw new Error(`Launcher template is missing the ${EXE_PLACEHOLDER} placeholder`)
  const launcher = template.split(EXE_PLACEHOLDER).join(escapePowerShellLiteral(paths.appPath))
  writeFileSync(paths.ps1, launcher, 'utf8')
  const vbsBytes = readFileSync(join(PAYLOAD_DIR, 'dsh-tray-start.vbs'))
  for (const byte of vbsBytes) {
    if (byte > 0x7f) throw new Error('The launcher VBS payload must be pure ASCII (Smart App Control / WSH requirement)')
  }
  writeFileSync(paths.vbs, vbsBytes)
  return { ps1Bytes: statSync(paths.ps1).size, vbsBytes: statSync(paths.vbs).size }
}

function createShortcut(paths) {
  const result = runPowerShell(CREATE_SHORTCUT_SCRIPT, {
    DSH_AUTOSTART_SHORTCUT: paths.shortcut,
    DSH_AUTOSTART_VBS: paths.vbs,
    DSH_AUTOSTART_INSTALL_DIR: paths.installDir,
    DSH_AUTOSTART_APP: paths.appPath,
  })
  if (result.status !== 0 || !result.stdout.includes('ok')) {
    throw new Error(`Could not create the startup shortcut: ${result.stderr || result.stdout || result.error}`)
  }
}

function enableShortcutApproval(paths) {
  const result = runPowerShell(ENABLE_APPROVAL_SCRIPT, { DSH_AUTOSTART_SHORTCUT_NAME: paths.shortcutName })
  if (result.status !== 0 || !result.stdout.includes('ok')) {
    throw new Error(`Could not mark the startup shortcut as approved: ${result.stderr || result.stdout || result.error}`)
  }
}

function disableShortcutApproval(paths) {
  runPowerShell(DISABLE_APPROVAL_SCRIPT, { DSH_AUTOSTART_SHORTCUT_NAME: paths.shortcutName })
}

function extractHiderSource(launcherText) {
  const markerStart = launcherText.indexOf("$hideSource = @'")
  if (markerStart === -1) return ''
  const bodyStart = launcherText.indexOf('\n', markerStart)
  if (bodyStart === -1) return ''
  const bodyEnd = launcherText.indexOf("\n'@", bodyStart)
  if (bodyEnd === -1) return ''
  return launcherText.slice(bodyStart + 1, bodyEnd).trim()
}

function checkHiderCompiles(paths) {
  let source = ''
  try {
    source = extractHiderSource(readFileSync(paths.ps1, 'utf8'))
  } catch {
    // reported below
  }
  if (!source) return { ok: false, detail: 'could not extract the embedded window-hider C# source' }
  const script = "Add-Type -TypeDefinition $env:DSH_AUTOSTART_CS -Language CSharp -ErrorAction Stop; Write-Output 'ok'"
  const result = runPowerShell(script, { DSH_AUTOSTART_CS: source })
  if (result.status === 0 && result.stdout.includes('ok')) {
    return { ok: true, detail: 'Add-Type compiled the embedded window-hider (same compile path used at sign-in)' }
  }
  return { ok: false, detail: (result.stderr || result.stdout || result.error || 'unknown Add-Type failure').slice(0, 400) }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function runChainCheck(paths, timeoutMs = 15000) {
  const tempLocalAppData = mkdtempSync(join(tmpdir(), 'dsh-autostart-'))
  const check = { ok: false, exitCode: null, lines: [], error: '' }
  try {
    const result = spawnSync('wscript.exe', ['//B', '//Nologo', paths.vbs], {
      env: { ...process.env, LOCALAPPDATA: tempLocalAppData },
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    })
    check.exitCode = result.status === null ? -1 : result.status
    if (result.error) check.error = String(result.error.message || result.error)
    const logPath = join(tempLocalAppData, 'DSH', 'tray-start.log')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (existsSync(logPath)) {
        const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        if (lines.length > 0) {
          check.lines = lines
          check.ok = lines.some((line) => line.includes('app already running') || line.includes('window hidden') || line.includes('launched pid') || line.includes('no window seen'))
          if (check.ok) break
        }
      }
      sleepSync(100)
    }
  } finally {
    try {
      rmSync(tempLocalAppData, { recursive: true, force: true })
    } catch {
      // best effort cleanup
    }
  }
  return check
}

function readLogTail(paths, maxLines = 6) {
  if (!existsSync(paths.logPath)) return []
  try {
    return readFileSync(paths.logPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-maxLines)
  } catch {
    return []
  }
}

export function autostartStatus() {
  const paths = computePaths()
  const shortcut = readShortcut(paths)
  const inspect = readInspectState(paths)
  const scriptsDeployed = existsSync(paths.ps1) && existsSync(paths.vbs)
  const enabled = Boolean(shortcut.exists) && scriptsDeployed
  const lines = []
  lines.push(`DSH autostart: ${enabled ? 'enabled' : 'disabled'}`)
  lines.push(`  app: ${paths.appPath}`)
  lines.push(`  startup shortcut: ${paths.shortcut}`)
  if (shortcut.exists) {
    lines.push(`    target: ${shortcut.target || '(empty)'}`)
    lines.push(`    arguments: ${shortcut.arguments || '(none)'}`)
    lines.push(`    working directory: ${shortcut.workingDirectory || '(empty)'}`)
    lines.push(`    icon: ${shortcut.icon || '(empty)'}`)
  } else {
    lines.push('    (missing)')
  }
  lines.push(`  startup approval: ${inspect.approval || 'unknown'}`)
  lines.push(`  launcher scripts: ${scriptsDeployed ? 'deployed' : 'missing'}`)
  if (scriptsDeployed) {
    lines.push(`    ${paths.ps1} (${statSync(paths.ps1).size} B)`)
    lines.push(`    ${paths.vbs} (${statSync(paths.vbs).size} B)`)
  }
  lines.push(`  smart app control: ${inspect.smartAppControl || 'unknown'}`)
  const tail = readLogTail(paths)
  if (tail.length > 0) {
    lines.push('  last launcher log lines:')
    for (const line of tail) lines.push(`    ${line}`)
  }
  return lines.join('\n')
}

export function enableAutostart(options = {}) {
  const paths = computePaths()
  const deployed = deployLauncher(paths)
  createShortcut(paths)
  enableShortcutApproval(paths)
  const shortcut = readShortcut(paths)
  const lines = []
  lines.push('DSH autostart: enabled')
  lines.push(`  app: ${paths.appPath}`)
  lines.push(`  launcher scripts: ${paths.ps1} (${deployed.ps1Bytes} B), ${paths.vbs} (${deployed.vbsBytes} B)`)
  lines.push(`  startup shortcut: ${paths.shortcut}`)
  lines.push(`    target: ${shortcut.target || '(empty)'}`)
  lines.push(`    arguments: ${shortcut.arguments || '(none)'}`)
  lines.push(`    working directory: ${shortcut.workingDirectory || '(empty)'}`)
  lines.push('  startup approval: enabled')
  if (options.verifyChain !== false) {
    const compile = checkHiderCompiles(paths)
    lines.push(`  window-hider compile check: ${compile.ok ? 'PASS' : 'FAIL'}`)
    lines.push(`    ${compile.detail}`)
    const check = runChainCheck(paths)
    lines.push(`  signed-host chain check: ${check.ok ? 'PASS' : 'FAIL'}`)
    if (check.lines.length > 0) {
      for (const line of check.lines) lines.push(`    ${line}`)
    } else {
      lines.push(`    no launcher log appeared within the timeout${check.error ? ` (${check.error})` : ''}`)
    }
  }
  return lines.join('\n')
}

export function disableAutostart() {
  const paths = computePaths()
  const shortcutExisted = existsSync(paths.shortcut)
  if (shortcutExisted) rmSync(paths.shortcut, { force: true })
  disableShortcutApproval(paths)
  return [
    'DSH autostart: disabled',
    `  startup shortcut: ${shortcutExisted ? `removed (${paths.shortcut})` : 'already absent'}`,
    '  startup approval entry: cleared',
    `  launcher scripts kept: ${paths.installDir}`,
  ].join('\n')
}

export function autostartVerify(options = {}) {
  const paths = computePaths()
  const checks = []
  const record = (ok, label, detail) => checks.push({ ok, label, detail })
  const scriptsDeployed = existsSync(paths.ps1) && existsSync(paths.vbs)
  record(scriptsDeployed, 'launcher scripts', scriptsDeployed ? `${paths.ps1} (${statSync(paths.ps1).size} B), ${paths.vbs} (${statSync(paths.vbs).size} B)` : `missing under ${paths.installDir}`)

  if (existsSync(paths.vbs)) {
    const bytes = readFileSync(paths.vbs)
    const nonAscii = bytes.findIndex((byte) => byte > 0x7f)
    record(nonAscii === -1, 'launcher VBS is pure ASCII', nonAscii === -1 ? 'ok' : `non-ASCII byte at offset ${nonAscii}`)
  }

  let shortcut = { exists: false, target: '', arguments: '', workingDirectory: '', icon: '' }
  let shortcutError = ''
  try {
    shortcut = readShortcut(paths)
  } catch (error) {
    shortcutError = String(error.message || error)
  }
  const targetName = basename(String(shortcut.target || '')).toLowerCase()
  record(shortcut.exists && targetName === 'wscript.exe', 'shortcut target is wscript.exe', shortcut.exists ? String(shortcut.target || '(empty)') : 'shortcut missing')
  record(shortcut.exists && String(shortcut.arguments || '').includes(paths.vbs), 'shortcut arguments launch the launcher VBS', shortcut.exists ? String(shortcut.arguments || '(none)') : 'shortcut missing')

  const inspect = readInspectState(paths)
  record(inspect.approval === 'enabled' || inspect.approval === 'absent', 'startup approval is not disabled', `state: ${inspect.approval || 'unknown'}`)

  if (existsSync(paths.ps1)) {
    const compile = checkHiderCompiles(paths)
    record(compile.ok, 'embedded window-hider compiles with Add-Type', compile.detail)
  }

  if (options.runChain !== false) {
    if (!existsSync(paths.vbs)) {
      record(false, 'signed-host chain', 'launcher VBS is missing')
    } else {
      const check = runChainCheck(paths)
      record(check.ok, 'signed-host chain (wscript -> PowerShell -> Add-Type)', check.ok ? check.lines.join(' | ') : `no usable launcher log within the timeout${check.error ? ` (${check.error})` : ''}`)
    }
  }

  const passed = checks.filter((check) => check.ok).length
  const lines = [`DSH autostart verify: ${passed === checks.length ? 'PASS' : 'FAIL'} (${passed}/${checks.length} checks)`]
  for (const check of checks) lines.push(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.label}: ${check.detail}`)
  lines.push(`Smart App Control: ${inspect.smartAppControl || 'unknown'} (the launcher uses Microsoft-signed wscript.exe/powershell.exe hosts, so enforcement is fine)`)
  if (shortcutError) lines.push(`Shortcut read error: ${shortcutError}`)
  lines.push(`App path: ${paths.appPath}`)
  return lines.join('\n')
}
