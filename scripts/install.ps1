# WrongForge installer (Windows).
#
#   irm https://raw.githubusercontent.com/WrongStack/WrongForge/main/scripts/install.ps1 | iex
#
# Verifies the download against the release's SHA256SUMS.txt, installs to
# %LOCALAPPDATA%\Programs\WrongForge\wrongforge.exe and adds that folder to
# the user PATH (no admin needed).
param(
  [string]$Version = "",            # empty = latest
  [string]$Repo = "WrongStack/WrongForge",
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\WrongForge"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$asset = "wrongforge-windows-x64.exe"

if (-not $Version) {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ Accept = "application/vnd.github+json" }
  $Version = $rel.tag_name
}
$base = "https://github.com/$Repo/releases/download/$Version"

Write-Host "-> $asset from $Repo $Version"
$tmp = Join-Path $env:TEMP "wrongforge-install-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Invoke-WebRequest -Uri "$base/$asset" -OutFile "$tmp\$asset"
  $sumsFile = "$tmp\SHA256SUMS.txt"
  try { Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -OutFile $sumsFile } catch { $sumsFile = $null }

  if ($sumsFile -and (Test-Path $sumsFile)) {
    $want = (Get-Content $sumsFile | Where-Object { $_ -match "\s$asset`$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
    if ($want) {
      $got = (Get-FileHash -Algorithm SHA256 "$tmp\$asset").Hash.ToLower()
      if ($got -ne $want.ToLower()) { throw "sha256 mismatch for $asset (wanted $want, got $got)" }
      Write-Host "+ sha256 verified"
    }
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Move-Item "$tmp\$asset" "$InstallDir\wrongforge.exe" -Force

  # user PATH (idempotent, no admin)
  $path = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($path -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$path;$InstallDir", "User")
    Write-Host "note: added $InstallDir to your user PATH - open a NEW terminal for it to apply"
  }

  Write-Host "+ installed: $InstallDir\wrongforge.exe"
  & "$InstallDir\wrongforge.exe" version
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
