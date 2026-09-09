$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-cargo.ps1')

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) "vterminal-cargo-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$script:cargoMessages = @()
$script:cargoExitCode = 0
$script:receivedArguments = @()
$script:passed = 0

function cargo {
  $script:receivedArguments = $args
  $script:cargoMessages | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 }
  $global:LASTEXITCODE = $script:cargoExitCode
}

function New-TestRuntime([string]$Name) {
  $output = Join-Path $fixtureRoot "$Name/out"
  foreach ($relativePath in @(
    'bin/llama.dll', 'bin/llama-common.dll', 'bin/ggml.dll', 'bin/ggml-base.dll',
    'backends/ggml-cpu-avx2.dll', 'backends/ggml-vulkan.dll'
  )) {
    $path = Join-Path $output $relativePath
    New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
    New-Item -ItemType File -Path $path | Out-Null
  }
  return $output
}

function New-BuildMessage([string]$Output, [string]$Version = '0.1.156') {
  return @{
    reason = 'build-script-executed'
    package_id = "registry+https://github.com/rust-lang/crates.io-index#llama-cpp-sys-2@$Version"
    out_dir = $Output
  }
}

function Assert-Throws([scriptblock]$Action, [string]$Expected) {
  try { & $Action }
  catch {
    if ($_.Exception.Message -notlike "*$Expected*") { throw }
    $script:passed++
    return
  }
  throw "Expected an error containing '$Expected'."
}

try {
  $stale = New-TestRuntime 'llama-cpp-sys-2-stale'
  $current = New-TestRuntime 'llama-cpp-sys-2-current'
  $script:cargoMessages = @(
    @{ reason = 'compiler-artifact'; fresh = $true },
    @{ reason = 'build-script-executed'; package_id = 'registry+example#unrelated@1.0'; out_dir = $stale },
    (New-BuildMessage $current),
    @{ reason = 'build-finished'; success = $true }
  )
  $selected = Invoke-LlamaCargo -CargoArguments @('build', '--locked', '--release')
  if ($selected -ne $current) { throw 'Selected a stale or unrelated runtime.' }
  if (($script:receivedArguments -join ' ') -ne 'build --message-format=json-render-diagnostics --locked --release') {
    throw 'Cargo did not receive the original build arguments and JSON output format.'
  }
  $script:passed++

  # Repeated fresh records must identify one output, and Clippy's forwarded
  # lint arguments must stay after its -- separator.
  $script:cargoMessages = @((New-BuildMessage $current), (New-BuildMessage $current))
  $selected = Invoke-LlamaCargo -CargoArguments @('clippy', '--all-targets', '--', '-D', 'warnings')
  if ($selected -ne $current -or
      ($script:receivedArguments -join ' ') -ne 'clippy --message-format=json-render-diagnostics --all-targets -- -D warnings') {
    throw 'Cached Clippy output or forwarded arguments were not preserved.'
  }
  $script:passed++

  $script:cargoExitCode = 101
  Assert-Throws { Invoke-LlamaCargo -CargoArguments @('build') } 'failed with exit code 101'
  $script:cargoExitCode = 0

  $script:cargoMessages = @(@{ reason = 'build-finished'; success = $true })
  Assert-Throws { Invoke-LlamaCargo -CargoArguments @('build') } 'found 0'

  $script:cargoMessages = @((New-BuildMessage $current), (New-BuildMessage $stale '0.1.154'))
  Assert-Throws { Invoke-LlamaCargo -CargoArguments @('build') } 'found 2'

  $script:cargoMessages = @(New-BuildMessage '')
  Assert-Throws { Invoke-LlamaCargo -CargoArguments @('build') } 'did not report an output directory'

  # A complete old cache must never make a broken current output acceptable.
  $script:cargoMessages = @(New-BuildMessage $current)
  Remove-Item -LiteralPath (Join-Path $current 'bin/ggml-base.dll')
  Assert-Throws { Invoke-LlamaCargo -CargoArguments @('build') } 'missing runtime or backend DLLs'
  New-Item -ItemType File -Path (Join-Path $current 'bin/ggml-base.dll') | Out-Null

  Remove-Item -LiteralPath (Join-Path $current 'backends/ggml-vulkan.dll')
  Assert-Throws { Invoke-LlamaCargo -CargoArguments @('build') } 'missing CPU or Vulkan backend DLLs'
  New-Item -ItemType File -Path (Join-Path $current 'backends/ggml-vulkan.dll') | Out-Null
  Remove-Item -LiteralPath (Join-Path $current 'backends/ggml-cpu-avx2.dll')
  Assert-Throws { Invoke-LlamaCargo -CargoArguments @('build') } 'missing CPU or Vulkan backend DLLs'

  $testProfileDirectory = Join-Path $fixtureRoot 'debug'
  $selectedLlama = Join-Path $current 'bin/llama.dll'
  $staleGgml = Join-Path $stale 'bin/ggml.dll'
  Set-Content -LiteralPath $selectedLlama -Value 'current llama'
  Set-Content -LiteralPath (Join-Path $current 'bin/ggml.dll') -Value 'current ggml'
  Set-Content -LiteralPath $staleGgml -Value 'old ggml'
  foreach ($directory in @($testProfileDirectory, (Join-Path $testProfileDirectory 'deps'))) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    # Cover both hard links already pointing at the selected output and links
    # into the old cache, whose source must never be overwritten.
    New-Item -ItemType HardLink -Path (Join-Path $directory 'llama.dll') -Target $selectedLlama | Out-Null
    New-Item -ItemType HardLink -Path (Join-Path $directory 'ggml.dll') -Target $staleGgml | Out-Null
    Set-Content -LiteralPath (Join-Path $directory 'ggml-obsolete.dll') -Value 'obsolete'
    Set-Content -LiteralPath (Join-Path $directory 'unrelated.dll') -Value 'leave alone'
  }
  Copy-LlamaTestRuntime -Output $current -ProfileDirectory $testProfileDirectory
  foreach ($directory in @($testProfileDirectory, (Join-Path $testProfileDirectory 'deps'))) {
    if ((Get-Content -LiteralPath (Join-Path $directory 'llama.dll')) -ne 'current llama' -or
        (Get-Content -LiteralPath (Join-Path $directory 'ggml.dll')) -ne 'current ggml' -or
        (Test-Path -LiteralPath (Join-Path $directory 'ggml-obsolete.dll')) -or
        (Get-Content -LiteralPath (Join-Path $directory 'unrelated.dll')) -ne 'leave alone') {
      throw 'Runtime refresh did not replace only the managed DLLs beside the test binaries.'
    }
  }
  if ((Get-Content -LiteralPath $selectedLlama) -ne 'current llama' -or
      (Get-Content -LiteralPath $staleGgml) -ne 'old ggml') {
    throw 'Runtime refresh changed a build output through an existing hard link.'
  }
  $script:passed++

  Copy-LlamaTestRuntime -Output $current -ProfileDirectory (Join-Path $fixtureRoot 'clean debug')
  if (-not (Test-Path -LiteralPath (Join-Path $fixtureRoot 'clean debug/deps/llama-common.dll'))) {
    throw 'Runtime refresh did not populate a clean profile directory.'
  }
  $script:passed++

  New-Item -ItemType File -Path (Join-Path $current 'bin/unsupported.dll') | Out-Null
  Assert-Throws { Copy-LlamaTestRuntime -Output $current -ProfileDirectory $testProfileDirectory } 'Unexpected runtime DLLs'

  Write-Host "Passed $script:passed Cargo runtime selection tests."
}
finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
  Remove-Item Function:cargo
}
