param(
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$model = Get-Content (Join-Path $PSScriptRoot 'local-inference-smoke-model.json') -Raw | ConvertFrom-Json
$destinationPath = [IO.Path]::GetFullPath($Destination)

function Test-SmokeModel([string]$Path) {
  return (Test-Path -LiteralPath $Path -PathType Leaf) -and
    (Get-Item -LiteralPath $Path).Length -eq $model.size -and
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $model.sha256
}

if (Test-SmokeModel $destinationPath) {
  Write-Host "Using verified Qwen3.5 2B MTP smoke model at $destinationPath"
  exit 0
}

New-Item -ItemType Directory -Force (Split-Path -Parent $destinationPath) | Out-Null
$partial = "$destinationPath.$([Guid]::NewGuid().ToString('N')).partial"
try {
  $uri = "https://huggingface.co/$($model.repo)/resolve/$($model.revision)/$($model.filename)"
  Invoke-WebRequest -Uri $uri -OutFile $partial -TimeoutSec 600
  if (-not (Test-SmokeModel $partial)) {
    throw 'The inference smoke model failed its pinned size or SHA256 check.'
  }
  Move-Item -LiteralPath $partial -Destination $destinationPath -Force
}
finally {
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
}
