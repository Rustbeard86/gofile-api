<#
.SYNOPSIS
    Builds Gofile Manager in release mode and drops the executable in release\.

.DESCRIPTION
    Compiles the Tauri app (app/src-tauri) with --release and copies the
    resulting self-contained exe to release\ at the repo root. The frontend is
    embedded into the binary at compile time, so the single exe is all you need
    (Windows 11 already ships the WebView2 runtime it relies on).

.PARAMETER Run
    Launch the app after building.

.EXAMPLE
    ./build-release.ps1

.EXAMPLE
    ./build-release.ps1 -Run
#>
[CmdletBinding()]
param(
    [switch] $Run
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$manifest = Join-Path $root 'app\src-tauri\Cargo.toml'
$outDir = Join-Path $root 'release'

if (-not (Test-Path $manifest)) {
    throw "Cannot find $manifest - run this script from the repo root."
}

Write-Host "Building Gofile Manager (release)..." -ForegroundColor Cyan
cargo build --release --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit $LASTEXITCODE)." }

$exe = Join-Path $root 'app\src-tauri\target\release\gofile-manager.exe'
if (-not (Test-Path $exe)) { throw "Build succeeded but $exe is missing." }

New-Item -ItemType Directory -Force $outDir | Out-Null
$dest = Join-Path $outDir 'gofile-manager.exe'
Copy-Item $exe $dest -Force

$size = [math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-Host "Output: $dest ($size MB)" -ForegroundColor Green

if ($Run) {
    Write-Host "Launching..." -ForegroundColor Cyan
    & $dest
}
