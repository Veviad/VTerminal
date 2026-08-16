param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("add", "remove")]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$Directory,

  # Test seam: calculate the result without touching the registry or user32.
  [Parameter(DontShow = $true)]
  [AllowEmptyString()]
  [string]$InputPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Normalize-PathEntry([string]$Value) {
  $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim())
  try { return [IO.Path]::GetFullPath($expanded).TrimEnd("\", "/") }
  catch { return $expanded.TrimEnd("\", "/") }
}

function Update-ManagedPath([string]$Current, [string]$Managed, [string]$Operation) {
  $entries = @(
    ($Current -split ";") |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ -ne "" -and (Normalize-PathEntry $_) -ine $Managed }
  )
  if ($Operation -eq "add") {
    $entries += $Managed
  }
  return $entries -join ";"
}

if ([string]::IsNullOrWhiteSpace($Directory)) {
  throw "The managed VTerminal CLI directory must not be empty."
}
if ($Directory.Contains(";")) {
  throw "The managed VTerminal CLI directory cannot contain the PATH separator ';'."
}
$managed = Normalize-PathEntry $Directory

$usingInputPath = $PSBoundParameters.ContainsKey("InputPath")
$current = if ($usingInputPath) {
  $InputPath
} else {
  [Environment]::GetEnvironmentVariable("Path", "User")
}
$next = Update-ManagedPath $current $managed $Mode

if ($usingInputPath) {
  return $next
}

[Environment]::SetEnvironmentVariable("Path", $next, "User")
$persisted = [string][Environment]::GetEnvironmentVariable("Path", "User")
if ($persisted -cne $next) {
  throw "The VTerminal CLI PATH change could not be verified after writing it."
}

Add-Type -Namespace VTerminal -Name EnvironmentBroadcast -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(
  IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
  uint flags, uint timeout, out UIntPtr result);
'@
$broadcast = [IntPtr]0xffff
$result = [UIntPtr]::Zero
$sent = [VTerminal.EnvironmentBroadcast]::SendMessageTimeout(
  $broadcast, 0x001A, [UIntPtr]::Zero, "Environment", 0x0002, 5000, [ref]$result
)
if ($sent -eq [IntPtr]::Zero) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $broadcastError = "The VTerminal CLI PATH was saved, but Windows did not broadcast the environment change (error $errorCode)."
  if ($Mode -eq "add") {
    throw $broadcastError
  }
  # Never trap a user in an installed application after the exact PATH entry
  # has already been removed. A sign-out or restart refreshes inherited
  # environments if this best-effort uninstall broadcast fails.
  Write-Warning $broadcastError
}
