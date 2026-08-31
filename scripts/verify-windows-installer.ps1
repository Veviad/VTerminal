param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,

  [Parameter(Mandatory = $true)]
  [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
$installerPath = [IO.Path]::GetFullPath($Installer)
$installDirectory = [IO.Path]::GetFullPath($InstallRoot)
$runtimeSource = Join-Path $repo "src-tauri\binaries\llama-runtime"
$backendSource = Join-Path $repo "src-tauri\binaries\llama-backends"
$expectedIconPath = Join-Path $repo "src-tauri\icons\icon.ico"
$managedBin = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Programs\VTerminal\bin"
$requiredRuntime = @("llama.dll", "llama-common.dll", "ggml.dll", "ggml-base.dll")

function Get-Dlls([string]$Directory) {
  return @(Get-ChildItem -LiteralPath $Directory -Filter "*.dll" -File | Sort-Object Name)
}

function Get-NormalizedPathEntries([AllowEmptyString()][string]$Value) {
  return @(
    ($Value -split ";") |
      ForEach-Object { $_.Trim().TrimEnd("\", "/").ToLowerInvariant() } |
      Where-Object { $_ -ne "" } |
      Sort-Object
  )
}

function Assert-RequiredPayload([IO.FileInfo[]]$Runtime, [IO.FileInfo[]]$Backends) {
  foreach ($name in $requiredRuntime) {
    if ($null -eq ($Runtime | Where-Object Name -EQ $name)) {
      throw "The staged Windows runtime is missing $name."
    }
  }
  if ($null -eq ($Backends | Where-Object Name -EQ "ggml-vulkan.dll")) {
    throw "The staged Windows payload is missing ggml-vulkan.dll."
  }
  if ($null -eq ($Backends | Where-Object Name -Match '^ggml-cpu(?:-.+)?\.dll$')) {
    throw "The staged Windows payload has no CPU backend."
  }
}

function Assert-MirroredFiles([IO.FileInfo[]]$Sources, [string]$Destination) {
  foreach ($source in $Sources) {
    $installed = Join-Path $Destination $source.Name
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) {
      throw "The installer omitted $installed."
    }
    $sourceHash = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash
    $installedHash = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
    if ($sourceHash -cne $installedHash) {
      throw "The installed $($source.Name) does not match the staged runtime."
    }
  }
}

function Invoke-HelpSmoke([string]$Executable) {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.WorkingDirectory = Split-Path -Parent $Executable
  $startInfo.Arguments = "--help"
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Could not start $Executable."
  }
  if (-not $process.WaitForExit(15000)) {
    $process.Kill()
    throw "$Executable did not exit within 15 seconds."
  }
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  if ($process.ExitCode -ne 0 -or $stdout -notmatch "vterminal-docs") {
    throw "$Executable failed its loader smoke test with exit $($process.ExitCode).`n$stdout`n$stderr"
  }
}

function Invoke-InstallerProcess(
  [string]$Executable,
  [string[]]$ArgumentList,
  [string]$Action
) {
  # PowerShell does not wait for GUI executables when they are invoked with &.
  # Start-Process -Wait also follows the temporary child used by NSIS uninstall.
  $process = Start-Process -FilePath $Executable -ArgumentList $ArgumentList -Wait -PassThru
  try {
    if ($process.ExitCode -ne 0) {
      throw "The silent Windows $Action failed with exit $($process.ExitCode)."
    }
  }
  finally {
    $process.Dispose()
  }
}

function Get-NormalizedIconHash($Icon) {
  $size = 32
  $rectangle = [Drawing.Rectangle]::new(0, 0, $size, $size)
  $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = $null
  $data = $null
  $sha = $null
  try {
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([Drawing.Color]::Transparent)
    $graphics.DrawIcon($Icon, $rectangle)
    $data = $bitmap.LockBits(
      $rectangle,
      [Drawing.Imaging.ImageLockMode]::ReadOnly,
      [Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $length = [Math]::Abs($data.Stride) * $data.Height
    $bytes = [byte[]]::new($length)
    [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $length)
    $sha = [Security.Cryptography.SHA256]::Create()
    return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "")
  }
  finally {
    if ($null -ne $data) { $bitmap.UnlockBits($data) }
    if ($null -ne $graphics) { $graphics.Dispose() }
    if ($null -ne $sha) { $sha.Dispose() }
    $bitmap.Dispose()
  }
}

function Get-IconResource([string]$Path) {
  $handles = [IntPtr[]]::new(1)
  $resourceIds = [uint32[]]::new(1)
  $count = [VTerminal.IconResource]::PrivateExtractIcons(
    $Path,
    0,
    32,
    32,
    $handles,
    $resourceIds,
    1,
    0
  )
  if ($count -ne 1 -or $handles[0] -eq [IntPtr]::Zero) {
    throw "Could not read the 32x32 Windows icon resource from $Path."
  }
  try {
    # Clone uses CopyIcon and owns an independent HICON. Release the original
    # handle returned by PrivateExtractIconsW immediately to avoid leaking it.
    return [Drawing.Icon]::FromHandle($handles[0]).Clone()
  }
  finally {
    [VTerminal.IconResource]::DestroyIcon($handles[0]) | Out-Null
  }
}

function Assert-ExecutableIcon([string]$Executable, [string]$ExpectedHash) {
  $icon = Get-IconResource $Executable
  try {
    $actualHash = Get-NormalizedIconHash $icon
    if ($actualHash -cne $ExpectedHash) {
      throw "$Executable does not contain the configured Veviad icon."
    }
  }
  finally {
    $icon.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "Windows installer not found at $installerPath."
}
if (Test-Path -LiteralPath $installDirectory) {
  throw "The isolated install destination already exists: $installDirectory"
}
if (Test-Path -LiteralPath $managedBin) {
  throw "Refusing to overwrite an existing managed VTerminal CLI at $managedBin."
}

$runtime = Get-Dlls $runtimeSource
$backends = Get-Dlls $backendSource
if ($runtime.Count -eq 0 -or $backends.Count -eq 0) {
  throw "The staged Windows local-model payload is empty."
}
Assert-RequiredPayload $runtime $backends

try {
  Add-Type -AssemblyName System.Drawing.Common -ErrorAction Stop
}
catch {
  Add-Type -AssemblyName System.Drawing
}
if (-not ("VTerminal.IconResource" -as [type])) {
  Add-Type -Namespace VTerminal -Name IconResource -MemberDefinition @'
[DllImport("user32.dll", EntryPoint = "PrivateExtractIconsW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
public static extern uint PrivateExtractIcons(
  string fileName,
  int iconIndex,
  int width,
  int height,
  [Out] IntPtr[] iconHandles,
  [Out] uint[] iconResourceIds,
  uint iconCount,
  uint flags);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(IntPtr icon);
'@
}
$expectedIcon = Get-IconResource $expectedIconPath
try {
  $expectedIconHash = Get-NormalizedIconHash $expectedIcon
}
finally {
  $expectedIcon.Dispose()
}
Assert-ExecutableIcon $installerPath $expectedIconHash

if (-not ("VTerminal.InstallerErrorMode" -as [type])) {
  Add-Type -Namespace VTerminal -Name InstallerErrorMode -MemberDefinition @'
[DllImport("kernel32.dll")]
public static extern uint SetErrorMode(uint mode);
'@
}

$originalUserPath = [string][Environment]::GetEnvironmentVariable("Path", "User")
$previousErrorMode = [VTerminal.InstallerErrorMode]::SetErrorMode(0x8003)
$verificationFailure = $null
$cleanupFailure = $null
$uninstaller = $null

try {
  Invoke-InstallerProcess -Executable $installerPath -ArgumentList @("/S", "/D=$installDirectory") -Action "install"

  if (-not (Test-Path -LiteralPath $installDirectory -PathType Container)) {
    throw "The silent Windows installer did not create $installDirectory."
  }
  $uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -Filter "uninstall*.exe" -File)
  if ($uninstallers.Count -ne 1) {
    throw "Expected one uninstaller in $installDirectory; found $($uninstallers.Count)."
  }
  $uninstaller = $uninstallers[0].FullName

  $installedApp = Join-Path $installDirectory "vterminal.exe"
  if (-not (Test-Path -LiteralPath $installedApp -PathType Leaf)) {
    throw "The installer omitted vterminal.exe."
  }
  Assert-ExecutableIcon $installedApp $expectedIconHash
  Assert-ExecutableIcon $uninstaller $expectedIconHash

  Assert-MirroredFiles $runtime $installDirectory
  Assert-MirroredFiles $backends (Join-Path $installDirectory "llama-backends")
  Assert-MirroredFiles $runtime $managedBin
  Assert-MirroredFiles $backends (Join-Path $managedBin "llama-backends")

  $bundledCli = Join-Path $installDirectory "vterminal-docs.exe"
  $managedCli = Join-Path $managedBin "vterminal-docs.exe"
  if (-not (Test-Path -LiteralPath $bundledCli -PathType Leaf)) {
    throw "The installer omitted its bundled vterminal-docs.exe."
  }
  if (-not (Test-Path -LiteralPath $managedCli -PathType Leaf)) {
    throw "The installer did not create the managed vterminal-docs.exe."
  }
  Invoke-HelpSmoke $bundledCli
  Invoke-HelpSmoke $managedCli
}
catch {
  $verificationFailure = $_
}
finally {
  try {
    if ($null -ne $uninstaller -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
      Invoke-InstallerProcess -Executable $uninstaller -ArgumentList @("/S") -Action "uninstall"
    }

    # NSIS can finish deleting its temporary uninstaller just after the parent
    # process exits. Give the pre-uninstall hook a bounded window to remove the
    # managed payload and PATH entry before checking its result.
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $managedBinPresent = Test-Path -LiteralPath $managedBin
      $installRootPresent = Test-Path -LiteralPath $installDirectory
      $currentPathEntries = Get-NormalizedPathEntries ([string][Environment]::GetEnvironmentVariable("Path", "User"))
      $managedPathEntry = $managedBin.TrimEnd("\", "/").ToLowerInvariant()
      if (-not $managedBinPresent -and -not $installRootPresent -and $currentPathEntries -inotcontains $managedPathEntry) {
        break
      }
      Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $cleanupDeadline)

    foreach ($name in @("vterminal-docs.exe") + @($runtime | ForEach-Object Name)) {
      if (Test-Path -LiteralPath (Join-Path $managedBin $name)) {
        throw "Uninstall left the managed CLI payload $name behind."
      }
    }
    if (Test-Path -LiteralPath (Join-Path $managedBin "llama-backends")) {
      $remainingBackends = Get-Dlls (Join-Path $managedBin "llama-backends")
      if ($remainingBackends.Count -ne 0) {
        throw "Uninstall left managed llama.cpp backends behind."
      }
    }
    if (Test-Path -LiteralPath $managedBin) {
      throw "Uninstall left the managed VTerminal CLI directory behind."
    }
    if (Test-Path -LiteralPath $installDirectory) {
      throw "Uninstall left the isolated VTerminal application directory behind."
    }
    $currentUserPath = [string][Environment]::GetEnvironmentVariable("Path", "User")
    $originalPathEntries = Get-NormalizedPathEntries $originalUserPath
    $currentPathEntries = Get-NormalizedPathEntries $currentUserPath
    if (Compare-Object $originalPathEntries $currentPathEntries) {
      throw "Uninstall did not restore the original user PATH entries."
    }
  }
  catch {
    $cleanupFailure = $_
  }
  [VTerminal.InstallerErrorMode]::SetErrorMode($previousErrorMode) | Out-Null
}

if ($null -ne $verificationFailure) {
  if ($null -ne $cleanupFailure) {
    throw "$($verificationFailure.Exception.Message)`nCleanup also failed: $($cleanupFailure.Exception.Message)"
  }
  throw $verificationFailure
}
if ($null -ne $cleanupFailure) {
  throw $cleanupFailure
}

Write-Host "Windows installer payload, loader, repair copy, and uninstall checks passed"
