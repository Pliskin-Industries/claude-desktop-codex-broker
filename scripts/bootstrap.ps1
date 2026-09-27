# Set up everything the Codex broker needs on a Windows machine, then check it.
#
# From the repo root, in a normal (not administrator) PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
#
# -ExecutionPolicy Bypass applies to this one run only; nothing is changed
# permanently. Safe to re-run: every step checks first and skips what is
# already done. It stops for the two things only you can do: `codex login`
# (interactive) and one administrator approval for Codex's sandbox setup.
#
# Steps: Node LTS, Git, (optionally) GitHub CLI via winget; Codex CLI via npm;
# server dependencies; Codex login; Codex's Windows sandbox; Codex config
# (keep-awake, model, effort); then scripts\doctor.mjs as the final check.
#
# Options:
#   -SkipSandbox   don't offer the administrator sandbox setup
#   -Model <id>    Codex default model (default gpt-6-astra)
#   -Effort <lvl>  Codex default reasoning effort (default ultra)

[CmdletBinding()]
param(
  [switch]$SkipSandbox,
  [string]$Model = 'gpt-6-astra',
  [string]$Effort = 'ultra'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$minCodex = [version]'0.153.1'
$minNode = [version]'18.18.0'

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Info([string]$msg) { Write-Host "    $msg" }
function Warn([string]$msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# A fresh install lands on PATH in the registry, not in this session.
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# Run a native program and judge it by exit code only. Windows PowerShell 5.1
# turns any stderr line into a terminating error under
# $ErrorActionPreference = 'Stop', and codex writes normal status there.
# -Interactive leaves the console attached (login, winget prompts).
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments = @(), [switch]$Interactive)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Interactive) {
      # Attached straight to this console (a real TTY for login prompts and
      # progress bars). Start-Process joins arguments with spaces unquoted, so
      # quote any that contain spaces.
      $quoted = $Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
      $start = @{ FilePath = $Exe; NoNewWindow = $true; Wait = $true; PassThru = $true }
      if ($quoted) { $start.ArgumentList = $quoted }
      $p = Start-Process @start
      return [pscustomobject]@{ Ok = ($p.ExitCode -eq 0); Code = $p.ExitCode; Out = '' }
    }
    $out = (& $Exe @Arguments 2>&1 | ForEach-Object { "$_" }) -join "`n"
    return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Code = $LASTEXITCODE; Out = $out.Trim() }
  } finally {
    $ErrorActionPreference = $old
  }
}

function Get-Version([string]$text) {
  $m = [regex]::Match($text, '(\d+)\.(\d+)\.(\d+)')
  if ($m.Success) { return [version]$m.Value }
  return $null
}

function Install-WithWinget([string]$id, [string]$what) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget is not available. Install '$what' yourself (or App Installer from the Microsoft Store), then re-run."
  }
  Info "installing $what with winget ($id); winget may ask you to accept its terms"
  $r = Invoke-Native winget @('install', '--id', $id, '-e') -Interactive
  if (-not $r.Ok) { throw "winget install $id failed (exit $($r.Code))" }
  Refresh-Path
}

# npm and codex are called through their .cmd shims: the .ps1 shims are what
# PowerShell's execution policy blocks.
function Npm {
  $r = Invoke-Native npm.cmd $args -Interactive
  if (-not $r.Ok) { throw "npm $($args -join ' ') failed (exit $($r.Code))" }
}

Set-Location $repo

Step 'Node.js'
$nodeVersion = $null
if (Get-Command node -ErrorAction SilentlyContinue) { $nodeVersion = Get-Version (Invoke-Native node @('--version')).Out }
if (-not $nodeVersion -or $nodeVersion -lt $minNode) {
  Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  $nodeVersion = Get-Version (Invoke-Native node @('--version')).Out
}
Info "node $nodeVersion"

Step 'Git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-WithWinget 'Git.Git' 'Git' }
Info (Invoke-Native git @('--version')).Out

Step 'GitHub CLI (optional: only the gh_* tools need it)'
if (Get-Command gh -ErrorAction SilentlyContinue) {
  Info (((Invoke-Native gh @('--version')).Out -split "`n") | Select-Object -First 1)
} else {
  $answer = Read-Host '    Install the GitHub CLI? [y/N]'
  if ($answer -match '^[yY]') { Install-WithWinget 'GitHub.cli' 'GitHub CLI'; Warn 'run `gh auth login` yourself afterwards' }
  else { Info 'skipped' }
}

Step 'Codex CLI'
# The shim lives in npm's global prefix, which is %APPDATA%\npm unless the
# user configured another one; ask npm rather than assume.
$npmPrefix = (Invoke-Native npm.cmd @('prefix', '-g')).Out.Trim()
if (-not $npmPrefix) { throw 'could not read the npm global prefix (npm.cmd prefix -g)' }
$codexCmd = Join-Path $npmPrefix 'codex.cmd'
$codexVersion = $null
if (Test-Path $codexCmd) { $codexVersion = Get-Version (Invoke-Native $codexCmd @('--version')).Out }
if (-not $codexVersion -or $codexVersion -lt $minCodex) {
  Info "installing @openai/codex (need $minCodex or later)"
  Npm install -g '@openai/codex@latest'
  if (-not (Test-Path $codexCmd)) { throw "npm reported success but $codexCmd is missing" }
  $codexVersion = Get-Version (Invoke-Native $codexCmd @('--version')).Out
  if (-not $codexVersion -or $codexVersion -lt $minCodex) { throw "Codex at $codexCmd is still older than $minCodex" }
}
Info "codex-cli $codexVersion ($codexCmd)"

Step 'Broker server dependencies'
# Installs from the lockfile only when it changed since the last recorded
# install (or none was recorded), so a pulled lockfile update isn't skipped.
$deps = Invoke-Native node @((Join-Path $repo 'scripts\update-broker.mjs'), '--deps-only') -Interactive
if (-not $deps.Ok) { throw 'installing server dependencies failed (node scripts\update-broker.mjs --deps-only)' }

Step 'Codex login'
$login = Invoke-Native $codexCmd @('login', 'status')
if ($login.Ok) {
  Info (($login.Out -split "`n") | Select-Object -First 1)
} else {
  Warn 'not logged in: starting `codex login`. Sign in with your ChatGPT account or API key.'
  Invoke-Native $codexCmd @('login') -Interactive | Out-Null
  if (-not (Invoke-Native $codexCmd @('login', 'status')).Ok) { throw 'codex login did not complete; run `codex.cmd login` and re-run this script' }
}

Step "Codex's Windows sandbox"
$sandboxOk = $false
try {
  $raw = (Invoke-Native $codexCmd @('doctor', '--json')).Out
  $doctor = $raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json
  $d = $doctor.checks.'sandbox.helpers'.details
  $sandboxOk = ($d.'sandbox backend' -eq 'elevated') -and ($d.'sandbox provisioning' -eq 'complete')
} catch { Warn "could not read codex doctor: $($_.Exception.Message)" }
if ($sandboxOk) {
  Info 'elevated sandbox, provisioning complete'
} elseif ($SkipSandbox) {
  Warn 'skipped (-SkipSandbox). Codex cannot run commands until this is done; see docs/LESSONS.md #11.'
} else {
  # --current-user records whoever runs the setup, so the elevated process must
  # be this same account: only offer it to a member of Administrators.
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdminAccount = $me.Groups.Value -contains 'S-1-5-32-544'
  $setupCmd = "& `"$codexCmd`" sandbox setup --elevated --current-user"
  if (-not $isAdminAccount) {
    # UAC with another account's credentials runs as that account, so
    # --current-user would provision the administrator, not you. Codex's
    # managed-deployment form names the user and their Codex home instead.
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    Warn "your account isn't an administrator, so this script can't provision the sandbox for you."
    Warn 'Ask an administrator to run this from an elevated PowerShell (it targets your account explicitly):'
    Warn "  & `"$codexCmd`" sandbox setup --elevated --user `"$($me.Name)`" --codex-home `"$codexHome`""
    Warn '(Codex documents this form for managed deployments; this project has only tested --current-user.)'
  } else {
    Info 'Codex runs its commands as dedicated sandbox users; creating them needs one administrator approval.'
    $answer = Read-Host '    Run the sandbox setup now (a UAC prompt will appear)? [Y/n]'
    if ($answer -match '^[nN]') {
      Warn "skipped. Later, from an administrator PowerShell: $setupCmd"
    } else {
      try {
        $p = Start-Process -FilePath $codexCmd -ArgumentList 'sandbox', 'setup', '--elevated', '--current-user' -Verb RunAs -Wait -PassThru
        if ($p.ExitCode -ne 0) { Warn "sandbox setup exited with $($p.ExitCode); the doctor check below will say what is missing" }
        else { Info 'sandbox setup finished' }
      } catch {
        Warn "sandbox setup did not run ($($_.Exception.Message)). Later, from an administrator PowerShell: $setupCmd"
      }
    }
  }
}

Step 'Codex config (keep-awake, model, effort)'
$cfg = Invoke-Native node @((Join-Path $repo 'scripts\configure-codex.mjs'), '--model', $Model, '--effort', $Effort)
Info ($cfg.Out -replace "`n", "`n    ")
if (-not $cfg.Ok) { throw 'configure-codex failed' }

Step 'Final check'
$ready = (Invoke-Native node @((Join-Path $repo 'scripts\doctor.mjs')) -Interactive).Ok

Step 'Next: connect Claude'
Info 'Claude Code, the Desktop Code tab, Cowork on this computer - install the plugin (it brings the broker and the skill):'
Info '  claude plugin marketplace add Pliskin-Industries/claude-desktop-codex-broker'
Info '  claude plugin install codex-broker@pliskin-industries'
Info '  (or in a session: /plugin marketplace add ..., /plugin install ...), then run /codex-broker:setup'
Info 'Claude Desktop chat: install codex-broker.mcpb from the latest release and set its Broker checkout to:'
Info "  $repo"
Info 'Then fully quit and reopen Claude so it picks up the new PATH: node scripts\update-broker.mjs --restart-only'
if (-not $ready) { exit 1 }
