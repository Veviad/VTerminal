$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "windows-import-audit.ps1")

$root = Join-Path ([IO.Path]::GetTempPath()) "vterminal-import-audit-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $root | Out-Null

# A hand-built PE is the only fixture that tests the RVA arithmetic without
# depending on a binary this repo does not control. The layout is the minimum
# the loader format requires: one section holding the import descriptors
# followed by the module-name strings they point at.
function New-TestPeImage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Module,

    [switch]$Pe32,

    [switch]$WithoutImports
  )

  $sectionRva = 0x1000
  $sectionOffset = 0x400
  $optionalHeaderSize = if ($Pe32) { 224 } else { 240 }
  $sectionHeaderOffset = 0x98 + $optionalHeaderSize

  $descriptorBytes = 20 * ($Module.Count + 1)
  $names = [Collections.Generic.List[byte]]::new()
  $nameRvas = @()
  # NOT `foreach ($module in $Module)`: PowerShell variable names are
  # case-insensitive, so the loop variable would overwrite the parameter and
  # $Module.Count would then be 1 for the descriptor loop below.
  foreach ($moduleName in $Module) {
    $nameRvas += $sectionRva + $descriptorBytes + $names.Count
    $names.AddRange([Text.Encoding]::ASCII.GetBytes($moduleName))
    $names.Add(0)
  }

  $sectionSize = $descriptorBytes + $names.Count
  $image = [byte[]]::new($sectionOffset + [Math]::Max($sectionSize, 16))

  function Set-UInt16([byte[]]$Buffer, [int]$Offset, [int]$Value) {
    [BitConverter]::GetBytes([uint16]$Value).CopyTo($Buffer, $Offset)
  }
  function Set-UInt32([byte[]]$Buffer, [int]$Offset, [int64]$Value) {
    [BitConverter]::GetBytes([uint32]$Value).CopyTo($Buffer, $Offset)
  }

  [Text.Encoding]::ASCII.GetBytes("MZ").CopyTo($image, 0)
  Set-UInt32 $image 0x3C 0x80
  [Text.Encoding]::ASCII.GetBytes("PE").CopyTo($image, 0x80)

  Set-UInt16 $image 0x84 0x8664            # Machine
  Set-UInt16 $image 0x86 1                 # NumberOfSections
  Set-UInt16 $image 0x94 $optionalHeaderSize
  Set-UInt16 $image 0x98 $(if ($Pe32) { 0x10B } else { 0x20B })

  $dataDirectory = 0x98 + $(if ($Pe32) { 96 } else { 112 })
  if (-not $WithoutImports) {
    Set-UInt32 $image ($dataDirectory + 8) $sectionRva
    Set-UInt32 $image ($dataDirectory + 12) $descriptorBytes
  }

  [Text.Encoding]::ASCII.GetBytes(".rdata").CopyTo($image, $sectionHeaderOffset)
  Set-UInt32 $image ($sectionHeaderOffset + 8) $sectionSize
  Set-UInt32 $image ($sectionHeaderOffset + 12) $sectionRva
  Set-UInt32 $image ($sectionHeaderOffset + 16) $sectionSize
  Set-UInt32 $image ($sectionHeaderOffset + 20) $sectionOffset

  for ($index = 0; $index -lt $Module.Count; $index++) {
    Set-UInt32 $image ($sectionOffset + (20 * $index) + 12) $nameRvas[$index]
  }
  if ($names.Count -ne 0) {
    $names.ToArray().CopyTo($image, $sectionOffset + $descriptorBytes)
  }

  [IO.File]::WriteAllBytes($Path, $image)
  return $Path
}

function Assert-Equal([string]$Expected, [string]$Actual, [string]$Description) {
  if ($Expected -cne $Actual) {
    throw "$Description`nExpected: $Expected`nActual:   $Actual"
  }
}

function Assert-Throws([scriptblock]$Action, [string]$Expected, [string]$Description) {
  try {
    & $Action | Out-Null
  }
  catch {
    if ($_.Exception.Message -notmatch [regex]::Escape($Expected)) {
      throw "$Description`nExpected the error to mention: $Expected`nActual: $($_.Exception.Message)"
    }
    return
  }
  throw $Description
}

try {
  # --- the parser ------------------------------------------------------------

  $modules = @("KERNEL32.dll", "llama-common.dll", "libssl-3-x64.dll")
  $pe64 = New-TestPeImage -Path (Join-Path $root "pe64.dll") -Module $modules
  Assert-Equal ($modules -join ",") ((Get-PeImportedModule -Path $pe64) -join ",") `
    "A PE32+ import table must be read in order."

  $pe32 = New-TestPeImage -Path (Join-Path $root "pe32.dll") -Module @("kernel32.dll") -Pe32
  Assert-Equal "kernel32.dll" ((Get-PeImportedModule -Path $pe32) -join ",") `
    "PE32 places its data directories 16 bytes earlier and must still parse."

  $noImports = New-TestPeImage -Path (Join-Path $root "bare.dll") -Module @() -WithoutImports
  Assert-Equal "0" ([string]@(Get-PeImportedModule -Path $noImports).Count) `
    "An image with no import directory must report no imports."

  $notPe = Join-Path $root "relay"
  Set-Content -LiteralPath $notPe -Value "#!/bin/sh" -NoNewline
  Assert-Throws { Get-PeImportedModule -Path $notPe } "not a PE image" `
    "A non-PE file must be rejected rather than parsed as one."

  # --- the resolution policy -------------------------------------------------

  $payload = @("llama.dll", "llama-common.dll", "ggml.dll", "ggml-base.dll")

  Assert-Equal "" ((Get-UnresolvedPeImport -Imports $payload -Provided $payload) -join ",") `
    "Every shipped DLL must resolve against the payload."

  Assert-Equal "" ((Get-UnresolvedPeImport -Imports @("LLAMA.DLL", "KERNEL32.dll") -Provided $payload) -join ",") `
    "Import names are case-insensitive; one binary spells them both ways."

  Assert-Equal "" ((Get-UnresolvedPeImport `
        -Imports @("api-ms-win-crt-stdio-l1-1-0.dll", "ext-ms-win-ntuser-dialogbox-l1-1-0.dll") `
        -Provided @()) -join ",") `
    "ApiSet forwarders are resolved by the loader itself."

  Assert-Equal "" ((Get-UnresolvedPeImport -Imports @("MSVCP140.dll", "VCRUNTIME140_1.dll") -Provided @()) -join ",") `
    "The VC++ redistributable is an accepted, documented assumption."

  Assert-Equal "libcrypto-3-x64.dll,libssl-3-x64.dll" `
    ((Get-UnresolvedPeImport -Imports @("libssl-3-x64.dll", "ggml.dll", "libcrypto-3-x64.dll") -Provided $payload) -join ",") `
    "An unshipped third-party DLL must be reported; this is the v0.6.0 startup failure."

  Assert-Equal "vulkan-1.dll" ((Get-UnresolvedPeImport -Imports @("vulkan-1.dll") -Provided @()) -join ",") `
    "A driver-installed DLL must not resolve for a load-critical file."

  Assert-Equal "" ((Get-UnresolvedPeImport -Imports @("vulkan-1.dll") -Provided @() -AllowDriverProvided) -join ",") `
    "A runtime-loaded backend may depend on a driver-installed DLL."

  # --- the closure over a staged payload -------------------------------------

  $app = Join-Path $root "app"
  $backends = Join-Path $root "app/llama-backends"
  New-Item -ItemType Directory -Path $backends -Force | Out-Null

  $clean = @(
    New-TestPeImage -Path (Join-Path $app "vterminal.exe") -Module @("kernel32.dll", "llama-common.dll", "ggml.dll")
    New-TestPeImage -Path (Join-Path $app "llama-common.dll") -Module @("ggml-base.dll", "MSVCP140.dll")
    New-TestPeImage -Path (Join-Path $app "ggml.dll") -Module @("ggml-base.dll")
    New-TestPeImage -Path (Join-Path $app "ggml-base.dll") -Module @("kernel32.dll")
  )
  # ggml-base.dll lives one directory up and is already resident when a backend
  # is loaded, so it must resolve from the application set.
  $cleanBackend = @(
    New-TestPeImage -Path (Join-Path $backends "ggml-vulkan.dll") -Module @("ggml-base.dll", "vulkan-1.dll")
    New-TestPeImage -Path (Join-Path $backends "ggml-cpu-haswell.dll") -Module @("ggml-base.dll")
  )
  Assert-WindowsImportClosure -ApplicationFile $clean -BackendFile $cleanBackend -Label "clean fixture" | Out-Null

  $dirty = New-TestPeImage -Path (Join-Path $app "llama-common.dll") -Module @("ggml-base.dll", "libssl-3-x64.dll")
  Assert-Throws { Assert-WindowsImportClosure -ApplicationFile $clean -BackendFile $cleanBackend -Label "dirty fixture" } `
    "llama-common.dll imports libssl-3-x64.dll" `
    "An unshipped import must fail the audit and name the file that carries it."
  $null = $dirty

  $null = New-TestPeImage -Path (Join-Path $app "llama-common.dll") -Module @("ggml-base.dll", "MSVCP140.dll")
  $vulkanInApp = New-TestPeImage -Path (Join-Path $app "ggml.dll") -Module @("ggml-base.dll", "vulkan-1.dll")
  Assert-Throws { Assert-WindowsImportClosure -ApplicationFile $clean -BackendFile $cleanBackend -Label "app vulkan fixture" } `
    "ggml.dll imports vulkan-1.dll" `
    "vulkan-1.dll is only tolerable in a backend that may fail to load."
  $null = $vulkanInApp

  Assert-Throws {
    Assert-WindowsImportClosure -ApplicationFile @(Join-Path $app "absent.dll") -BackendFile @() -Label "missing fixture"
  } "cannot read" "A missing payload file must fail the audit rather than be skipped."

  Assert-Throws {
    Assert-WindowsImportClosure -ApplicationFile @() -BackendFile @() -Label "empty fixture"
  } "no files to check" "An empty payload must fail rather than vacuously pass."
}
finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "windows-import-audit tests passed"
