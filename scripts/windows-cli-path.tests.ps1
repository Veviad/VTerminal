$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot "windows-cli-path.ps1"
$managed = Join-Path ([IO.Path]::GetTempPath()) "VTerminal Tests/bin"
$other = Join-Path ([IO.Path]::GetTempPath()) "Unrelated/bin"

function Invoke-PathUpdate([string]$Mode, [AllowEmptyString()][string]$Current) {
  return & $scriptPath -Mode $Mode -Directory $managed -InputPath $Current
}

function Assert-Equal([string]$Expected, [string]$Actual, [string]$Description) {
  if ($Expected -cne $Actual) {
    throw "$Description`nExpected: $Expected`nActual:   $Actual"
  }
}

$added = Invoke-PathUpdate "add" $other
Assert-Equal "$other;$managed" $added "Add must preserve unrelated entries and append the managed directory."

$duplicate = "$other;$managed;$($managed.ToUpperInvariant())/"
$deduplicated = Invoke-PathUpdate "add" $duplicate
Assert-Equal "$other;$managed" $deduplicated "Add must be idempotent and compare normalized entries case-insensitively."

$removed = Invoke-PathUpdate "remove" "$other;$managed"
Assert-Equal $other $removed "Remove must delete only the exact managed directory."

$similar = "$($managed)-tools"
$preserved = Invoke-PathUpdate "remove" "$similar;$managed;$other"
Assert-Equal "$similar;$other" $preserved "Remove must preserve prefix-similar and unrelated directories."

$fromEmpty = Invoke-PathUpdate "add" ""
Assert-Equal $managed $fromEmpty "Add must support an empty user PATH."

$emptyAfterRemove = Invoke-PathUpdate "remove" $managed
Assert-Equal "" $emptyAfterRemove "Remove must support a PATH containing only the managed directory."

$rejectedEmptyDirectory = $false
try {
  & $scriptPath -Mode "add" -Directory " " -InputPath $other | Out-Null
} catch {
  $rejectedEmptyDirectory = $true
}
if (-not $rejectedEmptyDirectory) {
  throw "A blank managed directory must be rejected."
}

$rejectedSeparator = $false
try {
  & $scriptPath -Mode "add" -Directory "$managed;injected" -InputPath $other | Out-Null
} catch {
  $rejectedSeparator = $true
}
if (-not $rejectedSeparator) {
  throw "A managed directory containing a PATH separator must be rejected."
}

Write-Host "windows-cli-path tests passed"
