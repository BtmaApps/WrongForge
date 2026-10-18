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
# Resolve custom relative paths before persisting them in PATH.
$InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
if ($InstallDir -ne [IO.Path]::GetPathRoot($InstallDir)) { $InstallDir = $InstallDir.TrimEnd('\', '/') }

function Add-WrongForgePath([string]$ExistingPath) {
  # Compare complete entries, not substrings (e.g. WrongForge-old).
  $entries = @($ExistingPath -split ';' | Where-Object {
    $_ -and [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\', '/') -ine $InstallDir
  })
  return (@($InstallDir) + $entries) -join ';'
}

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
  $newPath = Add-WrongForgePath $path
  if ($path -cne $newPath) {
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    # Notify Explorer so terminals launched from the desktop inherit the change.
    if (-not ('WrongForge.EnvironmentNotification' -as [type])) {
      Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace WrongForge {
  public static class EnvironmentNotification {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
      UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
  }
}
'@
    }
    $notificationResult = [UIntPtr]::Zero
    [void][WrongForge.EnvironmentNotification]::SendMessageTimeout(
      [IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, "Environment", 2, 1000, [ref]$notificationResult)
  }
  # Also fix the installing shell and all processes started from it.
  $env:Path = Add-WrongForgePath $env:Path

  Write-Host "+ installed: $InstallDir\wrongforge.exe"
  & "$InstallDir\wrongforge.exe" version
  if ($LASTEXITCODE -ne 0) { throw "Installed wrongforge failed its version check (exit $LASTEXITCODE)" }
  Write-Host "+ ready: wrongforge (current terminal and future terminals)"
  Write-Host "note: other already-open terminals may need restarting to refresh PATH"

  # OAuth client config: deliberately not embedded in the binary (no
  # identifiers hardcoded in the source) and not written by `wrongforge
  # import` either, so a clean install otherwise has no way to refresh its
  # token until someone hand-copies oauth.config.example.json. Write it from
  # that same public, repo-tracked template here, once — a failure here
  # never fails the install, since the CLI falls back to CLAUDE_OAUTH_* env
  # vars.
  $cfgDir = if ($env:WRONGFORGE_HOME) { $env:WRONGFORGE_HOME } else { "$env:USERPROFILE\.wrongforge" }
  $cfgFile = "$cfgDir\oauth.json"
  if (-not (Test-Path $cfgFile)) {
    try {
      New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null
      Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$Repo/main/oauth.config.example.json" -OutFile "$cfgFile.tmp"
      Move-Item "$cfgFile.tmp" $cfgFile -Force
      Write-Host "+ OAuth client config: $cfgFile"
    } catch {
      Remove-Item "$cfgFile.tmp" -ErrorAction SilentlyContinue
      Write-Host "!! could not write the OAuth client config ($cfgFile) - set CLAUDE_OAUTH_CLIENT_ID, or run 'wrongforge import' / 'login' once you have one"
    }
  }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
