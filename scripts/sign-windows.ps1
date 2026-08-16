param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$File
)

$ErrorActionPreference = "Stop"
$required = $env:VTERMINAL_REQUIRE_WINDOWS_SIGNING -eq "1"
$settings = @(
  $env:AZURE_ARTIFACT_SIGNING_ENDPOINT,
  $env:AZURE_ARTIFACT_SIGNING_ACCOUNT,
  $env:AZURE_ARTIFACT_SIGNING_PROFILE
)
if ($settings | Where-Object { [string]::IsNullOrWhiteSpace($_) }) {
  if ($required) {
    throw "Azure Artifact Signing is required, but endpoint/account/profile is not configured."
  }
  Write-Host "Azure Artifact Signing is not configured; leaving $File unsigned for this local build."
  exit 0
}

& artifact-signing-cli `
  -e $env:AZURE_ARTIFACT_SIGNING_ENDPOINT `
  -a $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
  -c $env:AZURE_ARTIFACT_SIGNING_PROFILE `
  -d "VTerminal" `
  $File
if ($LASTEXITCODE -ne 0) {
  throw "Azure Artifact Signing failed for $File."
}

$signature = Get-AuthenticodeSignature -FilePath $File
if ($signature.Status -ne "Valid") {
  throw "Authenticode verification failed for ${File}: $($signature.Status) $($signature.StatusMessage)"
}
