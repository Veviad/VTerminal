# Windows PE import-closure audit.
#
# Dot-source this file to get `Get-PeImportedModule`, `Get-UnresolvedPeImport`
# and `Assert-WindowsImportClosure`.
#
# WHY THIS EXISTS. v0.6.0 could not start on Windows at all: llama.cpp's
# vendored cpp-httplib defaults to `LLAMA_OPENSSL=ON` and links
# OpenSSL::SSL/Crypto whenever `find_package(OpenSSL)` succeeds, so
# llama-common.dll gained hard imports on libssl-3-x64.dll and
# libcrypto-3-x64.dll. vterminal.exe imports llama-common.dll, so the Windows
# loader refused the process before main() with "Die Ausführung des Codes kann
# nicht fortgesetzt werden" on every machine without OpenSSL 3 installed. The
# build runner has those DLLs on PATH, so nothing failed while packaging.
#
# Neither existing loader smoke test could have caught it: both start
# vterminal-docs.exe, and the docs sidecar imports llama.dll/ggml*.dll but NOT
# llama-common.dll. Auditing import tables instead of starting a process is
# also deterministic — it does not depend on what happens to be on the build
# machine's PATH, which is the exact reason this shipped.
#
# The audit reads the normal import directory, the one the loader resolves at
# process start. Delay-loaded imports are deliberately out of scope: they fail
# at first call rather than at startup, and nothing here uses them.
#
# No `Set-StrictMode` here on purpose: dot-sourcing applies it to the CALLER's
# scope, and build-windows.ps1 does not run under it. These functions are
# strict-safe either way — the test file runs them under `-Version Latest`.

# Shipped with every supported Windows install. `api-ms-win-*`/`ext-ms-win-*`
# are ApiSet forwarders the loader resolves from the OS itself.
$script:WindowsProvidedModules = @(
  'advapi32.dll',
  'bcrypt.dll',
  'bcryptprimitives.dll',
  'combase.dll',
  'comctl32.dll',
  'crypt32.dll',
  'dwmapi.dll',
  'gdi32.dll',
  'kernel32.dll',
  'ntdll.dll',
  'ole32.dll',
  'oleaut32.dll',
  'pdh.dll',
  'powrprof.dll',
  'psapi.dll',
  'shell32.dll',
  'shlwapi.dll',
  'user32.dll',
  'ws2_32.dll'
)

# Redistributable, NOT part of Windows. Accepted deliberately: MSVC compiles
# both the Rust binaries and llama.cpp against the dynamic CRT, WebView2's own
# installer pulls it in, and Tauri's NSIS template does not bundle the redist.
# Listed by name so the assumption is visible rather than implied — a machine
# with no VC++ 2015-2022 runtime fails the same way OpenSSL did.
$script:VcRuntimeModules = @(
  'msvcp140.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll'
)

# Installed by GPU drivers, allowed for runtime-loaded backends ONLY. A missing
# vulkan-1.dll makes ggml-vulkan.dll fail its LoadLibrary and GGML falls back to
# a CPU module; the same import on a load-critical file would be fatal.
$script:DriverProvidedModules = @(
  'vulkan-1.dll'
)

function Get-PeImportedModule {
  [OutputType([string[]])]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $reader = [IO.BinaryReader]::new($stream)
    if ($stream.Length -lt 0x40 -or $reader.ReadUInt16() -ne 0x5A4D) {
      throw "$Path is not a PE image: no MZ signature."
    }
    $stream.Position = 0x3C
    $peHeader = [int64]$reader.ReadUInt32()
    if ($peHeader -le 0 -or $peHeader + 24 -gt $stream.Length) {
      throw "$Path is not a PE image: e_lfanew points outside the file."
    }
    $stream.Position = $peHeader
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw "$Path is not a PE image: no PE signature."
    }

    $stream.Position = $peHeader + 6
    $sectionCount = [int]$reader.ReadUInt16()
    $stream.Position = $peHeader + 20
    $optionalHeaderSize = [int]$reader.ReadUInt16()
    $optionalHeader = $peHeader + 24

    $stream.Position = $optionalHeader
    $magic = $reader.ReadUInt16()
    # PE32+ inserts eight-byte fields ahead of the data directories.
    $dataDirectory = $optionalHeader + $(if ($magic -eq 0x20B) { 112 } else { 96 })
    $stream.Position = $dataDirectory + 8
    $importRva = [int64]$reader.ReadUInt32()
    if ($importRva -eq 0) {
      return @()
    }

    # Every section, because a descriptor's Name RVA routinely points into a
    # different section than the descriptor array itself.
    $sections = @()
    for ($index = 0; $index -lt $sectionCount; $index++) {
      $stream.Position = $optionalHeader + $optionalHeaderSize + (40 * $index)
      $sectionName = [Text.Encoding]::ASCII.GetString($reader.ReadBytes(8)).TrimEnd([char]0)
      $virtualSize = [int64]$reader.ReadUInt32()
      $virtualAddress = [int64]$reader.ReadUInt32()
      $rawSize = [int64]$reader.ReadUInt32()
      $rawAddress = [int64]$reader.ReadUInt32()
      $sections += [PSCustomObject]@{
        Name           = $sectionName
        VirtualAddress = $virtualAddress
        VirtualSize    = $virtualSize
        RawAddress     = $rawAddress
        RawSize        = $rawSize
      }
    }

    $modules = [Collections.Generic.List[string]]::new()
    $descriptor = ConvertTo-PeFileOffset -Sections $sections -Rva $importRva -Path $Path
    while ($true) {
      $stream.Position = $descriptor + 12
      $nameRva = [int64]$reader.ReadUInt32()
      if ($nameRva -eq 0) {
        # The import directory is terminated by an all-zero descriptor; a zero
        # name RVA is the field that reaches zero first in practice.
        break
      }
      $stream.Position = ConvertTo-PeFileOffset -Sections $sections -Rva $nameRva -Path $Path
      $characters = [Collections.Generic.List[byte]]::new()
      while ($true) {
        $character = $reader.ReadByte()
        if ($character -eq 0) { break }
        $characters.Add($character)
      }
      $modules.Add([Text.Encoding]::ASCII.GetString($characters.ToArray()))
      $descriptor += 20
    }
    return @($modules)
  }
  finally {
    $stream.Dispose()
  }
}

function ConvertTo-PeFileOffset {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [object[]]$Sections,

    [Parameter(Mandatory = $true)]
    [int64]$Rva,

    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  foreach ($section in $Sections) {
    # A section's virtual size can exceed its raw size (it may declare space the
    # file has no bytes for) and vice versa (raw data is file-alignment padded).
    # Contain against the larger span so an RVA near either edge finds its
    # section, then decide whether the file actually holds those bytes.
    $span = [Math]::Max($section.VirtualSize, $section.RawSize)
    if ($Rva -lt $section.VirtualAddress -or $Rva -ge $section.VirtualAddress + $span) {
      continue
    }
    $offset = $Rva - $section.VirtualAddress
    if ($section.RawAddress -eq 0 -or $offset -ge $section.RawSize) {
      # Uninitialized space. An import table never lives here, and reading on
      # would silently return whatever follows the section's raw bytes.
      throw "$Path maps RVA $Rva into section '$($section.Name)', which has no file bytes at that offset."
    }
    return $section.RawAddress + $offset
  }
  throw "$Path has an import table RVA ($Rva) outside every section."
}

function Get-UnresolvedPeImport {
  [OutputType([string[]])]
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Imports,

    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Provided,

    [switch]$AllowDriverProvided
  )

  # Import names are case-insensitive and the same binary spells them both ways
  # (KERNEL32.dll and kernel32.dll appear in one import table).
  $resolvable = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in @($Provided) + $script:WindowsProvidedModules + $script:VcRuntimeModules) {
    $null = $resolvable.Add($name)
  }
  if ($AllowDriverProvided) {
    foreach ($name in $script:DriverProvidedModules) {
      $null = $resolvable.Add($name)
    }
  }

  return @(
    $Imports |
      Where-Object { $_ -notmatch '^(?:api|ext)-ms-win-' } |
      Where-Object { -not $resolvable.Contains($_) } |
      Sort-Object -Unique
  )
}

function Assert-WindowsImportClosure {
  param(
    # PEs that sit beside the executable. Everything they import is resolved at
    # process start, so an unshipped import here means the app cannot launch.
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$ApplicationFile,

    # GGML modules loaded later through LoadLibrary. These may additionally
    # depend on driver-installed DLLs, because failing to load one only costs
    # the corresponding backend.
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$BackendFile,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $files = @($ApplicationFile) + @($BackendFile)
  if ($files.Count -eq 0) {
    throw "The $Label import audit was given no files to check."
  }
  foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "The $Label import audit cannot read $file."
    }
  }
  # A DLL already resident in the process satisfies an import by name whatever
  # directory it came from, so the backends resolve ggml-base.dll from the
  # application directory. One shared provided-set models that.
  $provided = @($files | ForEach-Object { [IO.Path]::GetFileName($_) })

  $failures = [Collections.Generic.List[string]]::new()
  foreach ($file in $ApplicationFile) {
    foreach ($name in (Get-UnresolvedPeImport -Imports (Get-PeImportedModule -Path $file) -Provided $provided)) {
      $failures.Add("$([IO.Path]::GetFileName($file)) imports $name")
    }
  }
  foreach ($file in $BackendFile) {
    $imports = Get-PeImportedModule -Path $file
    foreach ($name in (Get-UnresolvedPeImport -Imports $imports -Provided $provided -AllowDriverProvided)) {
      $failures.Add("$([IO.Path]::GetFileName($file)) imports $name")
    }
  }

  if ($failures.Count -ne 0) {
    throw @"
The $Label payload imports DLLs it does not ship and Windows does not provide:
  $($failures -join "`n  ")
The Windows loader fails such a process before it runs any code. Either ship
the DLL or stop linking it. A third-party DLL appearing here usually means a
CMake dependency probe found something on the build machine that user machines
do not have — llama.cpp's OpenSSL/curl probes are the known offenders, and
.cargo/config.toml pins CMAKE_DISABLE_FIND_PACKAGE_OpenSSL for that reason.
After changing a CMAKE_* switch, run ``cargo clean -p llama-cpp-sys-2``:
llama-cpp-sys-2 only reruns for GGML_* environment changes, so an existing
build directory keeps the old link line, and the Windows CI cache revisions in
.github/workflows/windows-ci.yml and release.yml must be bumped too.
"@
  }

  Write-Host "$Label import closure verified across $($files.Count) PE files"
}
