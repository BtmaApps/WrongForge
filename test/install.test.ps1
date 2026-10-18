# Offline integration test. Replace download and registry boundaries only.
param([string]$InstallerScript = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $InstallerScript) { $InstallerScript = Join-Path $root 'scripts/install.ps1' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('wrongforge-install-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
$oldPath = $env:Path
$oldHome = $env:WRONGFORGE_HOME
# Isolate the OAuth config write (install.ps1 writes to $env:WRONGFORGE_HOME,
# or the real user profile otherwise) — a test run must never touch it.
$env:WRONGFORGE_HOME = Join-Path $tmp 'wf-home'
try {
  $fixture = Join-Path $tmp 'fixture.exe'
  $source = Join-Path $tmp 'fixture.cs'
  Set-Content $source 'class Fixture { static void Main() { System.Console.WriteLine("fixture-version"); } }'
  & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo "/out:$fixture" $source
  if ($LASTEXITCODE -ne 0) { throw 'fixture compilation failed' }
  function Invoke-WebRequest { param($Uri, $OutFile)
    if ($Uri.EndsWith('SHA256SUMS.txt')) { Set-Content $OutFile '' }
    elseif ($Uri.EndsWith('oauth.config.example.json')) { Set-Content $OutFile '{"clientId":"test-client-id"}' }
    else { Copy-Item $fixture $OutFile }
  }
  $state = @{ Path = "$tmp\tools-other;$tmp\keep" }
  $installer = (Get-Content $InstallerScript -Raw).
    Replace('[Environment]::GetEnvironmentVariable("Path", "User")', '$state.Path')
  $installer = $installer -replace '\[Environment\]::SetEnvironmentVariable\("Path", (.+), "User"\)', '$state.Path = $1'
  $installerPath = Join-Path $tmp 'install.ps1'
  Set-Content $installerPath $installer
  $dest = Join-Path $tmp 'tools'
  & $installerPath -Version v0.0.0 -InstallDir $dest
  if (-not (($state.Path -split ';') -contains $dest)) { throw 'FAIL: exact directory missing from user PATH (prefix collision)' }
  $oauthFile = Join-Path $env:WRONGFORGE_HOME 'oauth.json'
  if (-not (Select-String -Path $oauthFile -Pattern '"clientId"' -Quiet)) { throw 'FAIL: oauth.json was not written' }
  $oauthBefore = Get-Content $oauthFile -Raw
  Push-Location $env:TEMP
  try {
    if ((wrongforge version) -ne 'fixture-version') { throw 'FAIL: command unavailable from another directory in current shell' }
  } finally { Pop-Location }
  $firstPath = $state.Path
  & $installerPath -Version v0.0.0 -InstallDir "$dest\"
  if ($state.Path -ne $firstPath) { throw 'FAIL: duplicate PATH entry on reinstall' }
  if ((Get-Content $oauthFile -Raw) -ne $oauthBefore) { throw 'FAIL: oauth.json rewritten on repeat install' }
  if ($state.Path -notlike "*$tmp\keep*") { throw 'FAIL: existing PATH entry lost' }
  # New processes inherit the installer shell's updated PATH.
  & "$env:ComSpec" /d /c 'cd /d %TEMP% && wrongforge version'
  if ($LASTEXITCODE -ne 0) { throw 'FAIL: child cmd cannot resolve command' }
  Push-Location $tmp
  try {
    & $installerPath -Version v0.0.0 -InstallDir 'relative tools'
    if (($state.Path -split ';')[0] -ne (Join-Path $tmp 'relative tools')) { throw 'FAIL: relative install destination persisted in PATH' }
  } finally { Pop-Location }
  Write-Host 'PASS: Windows exact PATH entries, current shell, child cmd, repeat install'
} finally {
  $env:Path = $oldPath
  $env:WRONGFORGE_HOME = $oldHome
  Remove-Item -LiteralPath $tmp -Recurse -Force
}
