# Cargo emits build-script-executed records even when an artifact is fresh.
# Use that output to locate the runtime belonging to this build; a dependency
# update can leave several complete, incompatible versions in the cache.
function Invoke-LlamaCargo {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$CargoArguments
  )

  $outputs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $command = $CargoArguments[0]
  $commandArguments = @($CargoArguments | Select-Object -Skip 1)
  & cargo $command --message-format=json-render-diagnostics @commandArguments | ForEach-Object {
    $message = $_ | ConvertFrom-Json -ErrorAction Stop
    if ($message.reason -eq 'compiler-message' -and $message.message.rendered) {
      Write-Host $message.message.rendered
    }
    if ($message.reason -eq 'build-script-executed' -and
        $message.package_id -match '(?:^llama-cpp-sys-2 |#llama-cpp-sys-2@)') {
      if ([string]::IsNullOrWhiteSpace($message.out_dir)) {
        throw 'Cargo did not report an output directory for llama-cpp-sys-2.'
      }
      [void]$outputs.Add($message.out_dir)
    }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Cargo $command failed with exit code $LASTEXITCODE."
  }
  if ($outputs.Count -ne 1) {
    throw "Expected one llama-cpp-sys-2 output from Cargo; found $($outputs.Count)."
  }
  $output = @($outputs)[0]
  $runtime = Join-Path $output 'bin'
  $backends = Join-Path $output 'backends'
  $requiredRuntime = @('llama.dll', 'llama-common.dll', 'ggml.dll', 'ggml-base.dll')
  $missingRuntime = @(
    $requiredRuntime | Where-Object {
      -not (Test-Path -LiteralPath (Join-Path $runtime $_) -PathType Leaf)
    }
  )
  if ($missingRuntime.Count -ne 0 -or
      -not (Test-Path -LiteralPath $backends -PathType Container)) {
    throw "Cargo's llama.cpp output is missing runtime or backend DLLs: $output."
  }
  $backendDlls = @(Get-ChildItem -LiteralPath $backends -Filter '*.dll' -File)
  $hasCpu = $null -ne ($backendDlls | Where-Object Name -Match '^ggml-cpu(?:-.+)?\.dll$')
  $hasVulkan = $null -ne ($backendDlls | Where-Object Name -EQ 'ggml-vulkan.dll')
  if (-not $hasCpu -or -not $hasVulkan) {
    throw "Cargo's llama.cpp output is missing CPU or Vulkan backend DLLs: $output."
  }
  return $output
}

function Copy-LlamaTestRuntime {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Output,

    [Parameter(Mandatory = $true)]
    [string]$ProfileDirectory
  )

  $runtime = Join-Path $Output 'bin'
  $dlls = @(Get-ChildItem -LiteralPath $runtime -Filter '*.dll' -File)
  if ($dlls.Count -eq 0 -or @($dlls | Where-Object Name -NotMatch '^(?:llama|ggml).*\.dll$').Count -ne 0) {
    throw "Unexpected runtime DLLs in Cargo's llama.cpp output: $runtime."
  }
  foreach ($directory in @($ProfileDirectory, (Join-Path $ProfileDirectory 'deps'))) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    # The Windows loader searches beside an executable before PATH. Upstream
    # leaves existing DLL hard links untouched, so cached copies must be
    # unlinked before copying the selected runtime to avoid mutating an old
    # build output through its shared inode.
    Get-ChildItem -LiteralPath $directory -Filter '*.dll' -File |
      Where-Object Name -Match '^(?:llama|ggml).*\.dll$' |
      Remove-Item -Force
    foreach ($dll in $dlls) {
      Copy-Item -LiteralPath $dll.FullName -Destination (Join-Path $directory $dll.Name)
    }
  }
}
