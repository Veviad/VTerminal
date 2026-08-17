param(
  [switch]$RequireSigning
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$target = "x86_64-pc-windows-msvc"
$manifest = Join-Path $repo "src-tauri\Cargo.toml"
$targetRoot = if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
  Join-Path $repo "src-tauri\target"
} elseif ([IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) {
  $env:CARGO_TARGET_DIR
} else {
  Join-Path $repo $env:CARGO_TARGET_DIR
}
$release = Join-Path $targetRoot "$target\release"
$sidecarDestination = Join-Path $repo "src-tauri\binaries\vterminal-docs-$target.exe"
$runtimeDestination = Join-Path $repo "src-tauri\binaries\llama-runtime"
$backendDestination = Join-Path $repo "src-tauri\binaries\llama-backends"
$requiredRuntimeDlls = @("llama.dll", "ggml.dll", "ggml-base.dll")

Push-Location $repo
try {
  npm ci
  rustup target add $target
  cargo build --manifest-path $manifest --release --locked --features local-llm --target $target --bin vterminal --bin vterminal-docs

  New-Item -ItemType Directory -Force -Path (Split-Path $sidecarDestination) | Out-Null
  Copy-Item -Force (Join-Path $release "vterminal-docs.exe") $sidecarDestination

  New-Item -ItemType Directory -Force -Path $backendDestination | Out-Null
  Get-ChildItem -Path $backendDestination -Filter "*.dll" -File | Remove-Item -Force
  $buildRoot = Join-Path $release "build"
  $backendCandidates = @(
    Get-ChildItem -LiteralPath $buildRoot -Directory -Filter "llama-cpp-sys-2-*" | ForEach-Object {
      $candidate = Join-Path $_.FullName "out"
      $candidateRuntime = Join-Path $candidate "bin"
      $candidateBackends = Join-Path $candidate "backends"
      if ((Test-Path -LiteralPath $candidateRuntime -PathType Container) -and
          (Test-Path -LiteralPath $candidateBackends -PathType Container)) {
        $candidateDlls = @(Get-ChildItem -LiteralPath $candidateBackends -Filter "*.dll" -File)
        $hasVulkan = $null -ne ($candidateDlls | Where-Object Name -EQ "ggml-vulkan.dll")
        $hasCpu = $null -ne ($candidateDlls | Where-Object Name -Match '^ggml-cpu(?:-.+)?\.dll$')
        $hasRuntime = 0 -eq @(
          $requiredRuntimeDlls | Where-Object {
            -not (Test-Path -LiteralPath (Join-Path $candidateRuntime $_) -PathType Leaf)
          }
        ).Count
        if ($hasVulkan -and $hasCpu -and $hasRuntime) {
          $candidate
        }
      }
    }
  )
  if ($backendCandidates.Count -ne 1) {
    $found = if ($backendCandidates.Count -eq 0) { "none" } else { $backendCandidates -join ", " }
    throw "Expected exactly one complete llama.cpp CPU/Vulkan backend set; found $found. Remove stale Windows llama-cpp build outputs and rebuild."
  }
  $selectedBuild = $backendCandidates[0]

  # `dynamic-backends` makes the llama/GGML core a normal PE dependency. Source
  # core and modules from this SAME build output so stale hard links in Cargo's
  # profile directory can never mix ABIs. Core DLLs must be beside each EXE;
  # CPU/Vulkan modules are loaded later from llama-backends.
  New-Item -ItemType Directory -Force -Path $runtimeDestination | Out-Null
  Get-ChildItem -Path $runtimeDestination -Filter "*.dll" -File | Remove-Item -Force
  foreach ($name in $requiredRuntimeDlls) {
    $source = Join-Path (Join-Path $selectedBuild "bin") $name
    Copy-Item -LiteralPath $source -Destination (Join-Path $runtimeDestination $name) -Force
    $releaseDll = Join-Path $release $name
    # Cargo may hard-link this profile-level DLL to the selected build output.
    # Remove that destination first so PowerShell does not reject a self-copy.
    Remove-Item -LiteralPath $releaseDll -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $source -Destination $releaseDll -Force
  }

  $selectedBackends = Join-Path $selectedBuild "backends"
  $backendDlls = @(Get-ChildItem -LiteralPath $selectedBackends -Filter "*.dll" -File | Sort-Object Name)
  foreach ($dll in $backendDlls) {
    if ($dll.Name -notmatch '^ggml-(?:cpu(?:-.+)?|vulkan)\.dll$') {
      throw "Unexpected DLL in the selected llama backend directory: $($dll.Name)"
    }
    Copy-Item -LiteralPath $dll.FullName -Destination (Join-Path $backendDestination $dll.Name) -Force
  }

  $stagedRuntime = @(Get-ChildItem -LiteralPath $runtimeDestination -Filter "*.dll" -File | Select-Object -ExpandProperty Name | Sort-Object)
  $expectedRuntime = @($requiredRuntimeDlls | Sort-Object)
  if (Compare-Object $expectedRuntime $stagedRuntime) {
    throw "The staged llama runtime DLL set is incomplete or contains unexpected files."
  }
  $stagedBackends = @(Get-ChildItem -LiteralPath $backendDestination -Filter "*.dll" -File)
  if ($null -eq ($stagedBackends | Where-Object Name -EQ "ggml-vulkan.dll") -or
      $null -eq ($stagedBackends | Where-Object Name -Match '^ggml-cpu(?:-.+)?\.dll$')) {
    throw "The staged backend payload must contain Vulkan and at least one CPU implementation."
  }

  if ($RequireSigning) {
    $env:VTERMINAL_REQUIRE_WINDOWS_SIGNING = "1"
    & (Join-Path $repo "scripts\sign-windows.ps1") $sidecarDestination
    foreach ($dll in Get-ChildItem -LiteralPath $runtimeDestination -Filter "*.dll" -File) {
      & (Join-Path $repo "scripts\sign-windows.ps1") $dll.FullName
    }
    foreach ($dll in Get-ChildItem -Path $backendDestination -Filter "*.dll" -File) {
      & (Join-Path $repo "scripts\sign-windows.ps1") $dll.FullName
    }
  }

  npm run tauri build -- --target $target --bundles nsis --features local-llm --config src-tauri/tauri.updater.conf.json,src-tauri/tauri.windows.conf.json,src-tauri/tauri.windows.local-llm.conf.json
}
finally {
  Pop-Location
}
