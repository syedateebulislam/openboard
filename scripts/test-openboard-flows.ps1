param(
  [switch]$UseRealTokens,
  [switch]$KeepRuntimeConfig,
  [string]$NodeCommand = "node",
  [string]$OpenBoardEntry = "dist/index.js"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$OpenBoard = Join-Path $RepoRoot $OpenBoardEntry
$SampleDir = Join-Path $RepoRoot "tests/e2e/sample-data"
$RuntimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("openboard-flow-test-" + [System.Guid]::NewGuid().ToString("N"))
$RuntimeConfig = Join-Path $RuntimeRoot "config"
$RunId = (Get-Date).ToString("yyyyMMdd-HHmmss")
$Results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param(
    [string]$Name,
    [string]$Status,
    [int]$ExitCode,
    [string]$Output
  )
  $Results.Add([pscustomobject]@{
    name = $Name
    status = $Status
    exitCode = $ExitCode
    output = ($Output -replace "(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|vcp_[A-Za-z0-9_]+)", "[REDACTED]")
  }) | Out-Null
}

function Invoke-FlowCase {
  param(
    [string]$Name,
    [string[]]$CliArgs,
    [int[]]$AllowedExitCodes = @(0),
    [string[]]$MustContain = @()
  )

  Write-Host "==> $Name" -ForegroundColor Cyan
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $outputLines = & $NodeCommand $OpenBoard @CliArgs 2>&1
  $ErrorActionPreference = $previousErrorAction
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  $output = ($outputLines | Out-String)

  $ok = $AllowedExitCodes -contains $exitCode
  foreach ($needle in $MustContain) {
    if ($output -notmatch [regex]::Escape($needle)) {
      $ok = $false
      $output += "`n[MISSING EXPECTED TEXT] $needle"
    }
  }

  if ($ok) {
    Write-Host "PASS $Name" -ForegroundColor Green
    Add-Result $Name "pass" $exitCode $output
  } else {
    Write-Host "FAIL $Name (exit $exitCode)" -ForegroundColor Red
    Write-Host $output
    Add-Result $Name "fail" $exitCode $output
  }
}

function Get-RequiredToken {
  param(
    [string[]]$Names,
    [string]$Label
  )
  foreach ($name in $Names) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { return $value }
  }
  throw "Missing $Label token. Set one of: $($Names -join ', ')"
}

function Write-TestConfig {
  New-Item -ItemType Directory -Force -Path $RuntimeConfig | Out-Null
  $githubToken = Get-RequiredToken @("OPENBOARD_TEST_GITHUB_TOKEN", "GITHUB_TOKEN") "GitHub"
  $vercelToken = Get-RequiredToken @("OPENBOARD_TEST_VERCEL_TOKEN", "VERCEL_TOKEN") "Vercel"

  $config = [ordered]@{
    llm = [ordered]@{
      provider = "openai-codex"
      model = "gpt-5.5"
    }
    github = [ordered]@{
      token = $githubToken
    }
    vercel = [ordered]@{
      token = $vercelToken
    }
    credentials = [ordered]@{
      username = "admin"
      # Public bcryptjs example hash (not a real secret) — for the test config only.
      passwordHash = '$2a$10$7EqJtq98hPqEX7fNZaFWoOhi7wEu3Ea7fWkjvN.IpXhC.Q2gKXqUe'
      jwtSecret = "openboard-flow-test-jwt-secret"
    }
  }

  $config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $RuntimeConfig "config.json") -Encoding UTF8
}

function Assert-Built {
  if (!(Test-Path -LiteralPath $OpenBoard)) {
    Write-Host "dist/index.js not found. Building OpenBoard first..." -ForegroundColor Yellow
    Push-Location $RepoRoot
    try {
      npm run build
      if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
      Pop-Location
    }
  }
}

New-Item -ItemType Directory -Force -Path $RuntimeConfig | Out-Null
$oldConfigDir = $env:OPENBOARD_CONFIG_DIR
$oldSecret = $env:OPENBOARD_ENCRYPTION_SECRET
$env:OPENBOARD_CONFIG_DIR = $RuntimeConfig
$env:OPENBOARD_ENCRYPTION_SECRET = "openboard-flow-test-secret"
$env:OPENBOARD_REDUCE_MOTION = "1"

try {
  Assert-Built

  Invoke-FlowCase "version" @("--version") @(0) @("O p e n B o a r d", "v1.0.0")
  Invoke-FlowCase "help" @("--help") @(0) @("Usage", "agent create", "update")
  Invoke-FlowCase "start rejects non-tty" @("start") @(1) @("requires an interactive terminal")
  Invoke-FlowCase "unknown command" @("definitely-not-a-command") @(1) @("Unknown command")
  Invoke-FlowCase "agent create missing data" @("agent", "create", "--json") @(1) @("Missing required --data")
  Invoke-FlowCase "agent create invalid type" @("agent", "create", "--data", (Join-Path $SampleDir "rides.csv"), "--type", "bad", "--json") @(1) @("Invalid --type")
  Invoke-FlowCase "agent create missing file" @("agent", "create", "--data", (Join-Path $SampleDir "missing.csv"), "--name", "Missing Data", "--json") @(1) @("File not found")
  Invoke-FlowCase "agent update missing dashboard" @("agent", "update", "--prompt", "Add a chart", "--json") @(1) @("Missing required --dashboard")
  Invoke-FlowCase "agent update missing prompt" @("agent", "update", "--dashboard", "missing-dashboard", "--json") @(1) @("Missing required --prompt")
  Invoke-FlowCase "update missing selector" @("update") @(1) @("Missing required --dashboard")
  Invoke-FlowCase "update unknown dashboard" @("update", "--dashboard", "definitely-missing") @(1) @("Dashboard not found")

  if ($UseRealTokens) {
    Write-TestConfig
    $dashboardName = "Flow Test $RunId"
    $createOut = Join-Path $RuntimeRoot "agent-create.json"
    $updateOut = Join-Path $RuntimeRoot "agent-update.json"

    Invoke-FlowCase "agent create real data" @(
      "agent", "create",
      "--data", (Join-Path $SampleDir "rides.csv"),
      "--name", $dashboardName,
      "--type", "custom",
      "--prompt", "Create a compact operations dashboard with ride volume, fare trend, city breakdown, driver performance, and cancellation rate.",
      "--json"
    ) @(0) @('"success": true', '"dashboardSelector"')

    $lastCreate = $Results[$Results.Count - 1].output
    $lastCreate | Set-Content -LiteralPath $createOut -Encoding UTF8
    $selectorMatch = [regex]::Match($lastCreate, '"dashboardSelector"\s*:\s*"([^"]+)"')
    if (!$selectorMatch.Success) {
      throw "Could not extract dashboardSelector from agent create output."
    }
    $selector = $selectorMatch.Groups[1].Value

    Invoke-FlowCase "agent update real prompt" @(
      "agent", "update",
      "--dashboard", $selector,
      "--data", (Join-Path $SampleDir "rides_updated.csv"),
      "--prompt", "Refresh the dashboard with the latest rows and add a weekly fare summary.",
      "--json"
    ) @(0) @('"success": true', '"action": "update"')

    $Results[$Results.Count - 1].output | Set-Content -LiteralPath $updateOut -Encoding UTF8

    Invoke-FlowCase "non-interactive update real history" @("update", "--dashboard", $selector) @(0) @("Updated dashboard")
  } else {
    Write-Host "Skipping real token-backed create/update/deploy flows. Re-run with -UseRealTokens after exporting tokens." -ForegroundColor Yellow
  }
} finally {
  $summaryPath = Join-Path $RuntimeRoot "summary.json"
  $Results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
  Write-Host "Summary: $summaryPath" -ForegroundColor Cyan

  if ($oldConfigDir) { $env:OPENBOARD_CONFIG_DIR = $oldConfigDir } else { Remove-Item Env:\OPENBOARD_CONFIG_DIR -ErrorAction SilentlyContinue }
  if ($oldSecret) { $env:OPENBOARD_ENCRYPTION_SECRET = $oldSecret } else { Remove-Item Env:\OPENBOARD_ENCRYPTION_SECRET -ErrorAction SilentlyContinue }
  Remove-Item Env:\OPENBOARD_REDUCE_MOTION -ErrorAction SilentlyContinue

  if (!$KeepRuntimeConfig) {
    Write-Host "Runtime config/data kept only in memory during test; deleting $RuntimeRoot" -ForegroundColor DarkGray
    Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "Runtime config retained at $RuntimeRoot" -ForegroundColor Yellow
  }
}

$failed = @($Results | Where-Object { $_.status -ne "pass" })
if ($failed.Count -gt 0) {
  Write-Host "$($failed.Count) flow case(s) failed." -ForegroundColor Red
  exit 1
}

Write-Host "All selected OpenBoard flow cases passed." -ForegroundColor Green
