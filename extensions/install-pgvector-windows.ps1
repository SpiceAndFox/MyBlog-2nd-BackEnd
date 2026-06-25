param(
  [string]$PgRoot = "",
  [string]$PgVectorVersion = "v0.8.3",
  [string]$DatabaseUrl = "",
  [string]$EnvFile = "",
  [switch]$SkipBuild,
  [switch]$EnableDatabase
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function Read-EnvValue {
  param(
    [string]$Path,
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return ""
  }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    $parts = $trimmed -split "=", 2
    if ($parts.Length -ne 2) {
      continue
    }
    if ($parts[0].Trim() -eq $Name) {
      return $parts[1].Trim()
    }
  }

  return ""
}

function Resolve-PgRoot {
  param([string]$Candidate)

  if ($Candidate) {
    return (Resolve-Path -LiteralPath $Candidate).Path
  }

  if ($env:PGROOT) {
    return (Resolve-Path -LiteralPath $env:PGROOT).Path
  }

  $psql = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($psql) {
    $bin = Split-Path -Parent $psql.Source
    return (Resolve-Path (Join-Path $bin "..")).Path
  }

  throw "Could not resolve PostgreSQL root. Pass -PgRoot or put psql.exe on PATH."
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $FilePath $($Arguments -join ' ')"
  }
}

$repoRoot = Resolve-RepoRoot
if (-not $EnvFile) {
  $EnvFile = Join-Path $repoRoot ".env"
}

$resolvedPgRoot = Resolve-PgRoot -Candidate $PgRoot
$pgBin = Join-Path $resolvedPgRoot "bin"
$pgConfig = Join-Path $pgBin "pg_config.exe"
$psql = Join-Path $pgBin "psql.exe"

if (-not (Test-Path -LiteralPath $pgConfig)) {
  throw "pg_config.exe not found at $pgConfig"
}
if (-not (Test-Path -LiteralPath $psql)) {
  throw "psql.exe not found at $psql"
}

$env:PGROOT = $resolvedPgRoot
$env:PATH = "$pgBin;$env:PATH"

Write-Host "PostgreSQL root: $resolvedPgRoot"
Invoke-Checked -FilePath $pgConfig -Arguments @("--version")

if (-not $SkipBuild) {
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw "git.exe is required to build pgvector."
  }
  if (-not (Get-Command nmake.exe -ErrorAction SilentlyContinue)) {
    throw "nmake.exe is required. Run this from an x64 Native Tools Command Prompt for Visual Studio."
  }
  if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "cl.exe is required. Install Visual Studio C++ build tools and run from an x64 Native Tools Command Prompt."
  }

  $workDir = Join-Path $env:TEMP "pgvector-build"
  if (Test-Path -LiteralPath $workDir) {
    Remove-Item -LiteralPath $workDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null

  Push-Location $workDir
  try {
    Invoke-Checked -FilePath "git" -Arguments @(
      "clone",
      "--branch",
      $PgVectorVersion,
      "--depth",
      "1",
      "https://github.com/pgvector/pgvector.git"
    )
    Push-Location "pgvector"
    try {
      Invoke-Checked -FilePath "nmake" -Arguments @("/F", "Makefile.win")
      Invoke-Checked -FilePath "nmake" -Arguments @("/F", "Makefile.win", "install")
    } finally {
      Pop-Location
    }
  } finally {
    Pop-Location
  }
}

$probeDatabase = "template1"
if ($EnableDatabase) {
  if (-not $DatabaseUrl) {
    $DatabaseUrl = Read-EnvValue -Path $EnvFile -Name "DATABASE_URL"
  }
  if (-not $DatabaseUrl) {
    throw "Database URL is required to enable pgvector. Pass -DatabaseUrl or set DATABASE_URL in $EnvFile."
  }
  $probeDatabase = $DatabaseUrl
}

$available = & $psql --dbname $probeDatabase --tuples-only --no-align --command "SELECT default_version FROM pg_available_extensions WHERE name = 'vector';"
if (-not $available.Trim()) {
  throw "pgvector was not found in pg_available_extensions after installation."
}

Write-Host "pgvector available version: $($available.Trim())"

if ($EnableDatabase) {
  Invoke-Checked -FilePath $psql -Arguments @(
    "--dbname",
    $DatabaseUrl,
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    "CREATE EXTENSION IF NOT EXISTS vector;"
  )
  Write-Host "pgvector extension enabled in target database."
}
