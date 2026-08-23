$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "src-tauri\mcp-relay"
$destination = Join-Path $repo "src-tauri\binaries\vterminal-mcp-relay"

Get-Command go -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null

$oldCgo = $env:CGO_ENABLED
$oldGoos = $env:GOOS
$oldGoarch = $env:GOARCH
Push-Location $source
try {
  $env:CGO_ENABLED = "0"
  $env:GOOS = "linux"
  $env:GOARCH = "amd64"
  go build -trimpath -ldflags "-s -w" -o $destination .
}
finally {
  $env:CGO_ENABLED = $oldCgo
  $env:GOOS = $oldGoos
  $env:GOARCH = $oldGoarch
  Pop-Location
}
