# Kept as functions so output validation can be tested without a GPU or model.
function Assert-InferenceSmokeResult {
  param(
    [Parameter(Mandatory = $true)][string]$Output,
    [Parameter(Mandatory = $true)][ValidateSet('cpu', 'vulkan')][string]$ExpectedBackend
  )
  $result = $Output | ConvertFrom-Json -ErrorAction Stop
  if ($result.ok -ne $true -or $result.backend -ne $ExpectedBackend) {
    throw "Inference did not succeed on the required $ExpectedBackend backend."
  }
  if ($result.mtp.mode -ne 'mtp' -or $result.mtp.drafted_tokens -le 0 -or
      $result.mtp.completion_tokens -le 0 -or $result.mtp.backend -ne $ExpectedBackend) {
    throw 'The native smoke did not actually generate with MTP enabled.'
  }
  if ($result.standard.mode -ne 'standard' -or $result.standard.completion_tokens -le 0 -or
      $result.standard.drafted_tokens -ne 0 -or $result.standard.backend -ne $ExpectedBackend) {
    throw 'The native smoke did not complete standard generation on the required backend.'
  }
  if ($result.repeated_mtp.mode -ne 'mtp' -or $result.repeated_mtp.drafted_tokens -le 0 -or
      $result.repeated_mtp.completion_tokens -le 0 -or $result.repeated_mtp.backend -ne $ExpectedBackend) {
    throw 'The native smoke did not repeat MTP generation on the required backend.'
  }
  if ($result.chat.mode -ne 'mtp' -or $result.chat.drafted_tokens -le 0 -or
      $result.chat.completion_tokens -le 0 -or $result.chat.backend -ne $ExpectedBackend) {
    throw 'The native smoke did not complete ordinary chat with MTP.'
  }
  if ($result.tool_result_round.ok -ne $true -or $result.tool_result_round.tool_calls -le 0) {
    throw 'The native smoke did not continue after an actual tool call.'
  }
  if ($result.cancellation.ok -ne $true -or $result.cancellation.resumed -ne $true) {
    throw 'The native smoke did not cancel and resume inference.'
  }
}

function Invoke-WindowsInferenceSmoke {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
    [Parameter(Mandatory = $true)][string]$BackendDirectory,
    [Parameter(Mandatory = $true)][string]$ModelPath,
    [ValidateSet('cpu', 'vulkan')][string]$ExpectedBackend = 'cpu',
    [ValidateRange(1, 1800)][int]$TimeoutSeconds = 600
  )
  $ErrorActionPreference = 'Stop'
  $modelPath = (Resolve-Path -LiteralPath $ModelPath).Path
  $sandbox = Join-Path ([IO.Path]::GetTempPath()) "vterminal-inference-$([Guid]::NewGuid().ToString('N'))"
  $process = $null
  $started = $false
  try {
    New-Item -ItemType Directory -Path $sandbox | Out-Null
    $isolatedExe = Join-Path $sandbox 'local_inference_smoke.exe'
    Copy-Item -LiteralPath $Executable -Destination $isolatedExe
    $runtime = @(Get-ChildItem -LiteralPath $RuntimeDirectory -Filter '*.dll' -File |
      Where-Object Name -Match '^(?:llama|ggml).*\.dll$')
    foreach ($required in @('llama.dll', 'llama-common.dll', 'ggml.dll', 'ggml-base.dll')) {
      if ($required -notin $runtime.Name) { throw "Missing smoke runtime DLL: $required" }
    }
    $modules = Join-Path $sandbox 'llama-backends'
    New-Item -ItemType Directory -Path $modules | Out-Null
    $backends = @(Get-ChildItem -LiteralPath $BackendDirectory -Filter '*.dll' -File)
    if (@($backends | Where-Object Name -Match '^ggml-cpu(?:-.+)?\.dll$').Count -eq 0) {
      throw 'The smoke runtime has no CPU backend.'
    }
    if ('ggml-vulkan.dll' -notin $backends.Name) { throw 'The smoke runtime has no Vulkan backend.' }
    foreach ($dll in $runtime) { Copy-Item -LiteralPath $dll.FullName -Destination $sandbox }
    foreach ($dll in $backends) { Copy-Item -LiteralPath $dll.FullName -Destination $modules }

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $isolatedExe
    $start.WorkingDirectory = $sandbox
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # No build tree or developer-installed runtime may satisfy missing DLLs.
    $start.Environment['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Could not start native inference smoke.' }
    $started = $true
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $configuration = @{
      target = $modelPath
      backend = $(if ($ExpectedBackend -eq 'cpu') { 'cpu' } else { 'auto' })
      backend_modules = $modules
    } | ConvertTo-Json -Compress
    $process.StandardInput.WriteLine($configuration)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill($true)
      [void]$process.WaitForExit(5000)
      throw "Native inference smoke exceeded $TimeoutSeconds seconds."
    }
    if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) {
      throw 'Native inference smoke output did not close.'
    }
    if ($process.ExitCode -ne 0) {
      throw "Native inference smoke exited $($process.ExitCode).`n$($stderr.Result)"
    }
    Assert-InferenceSmokeResult -Output $stdout.Result -ExpectedBackend $ExpectedBackend
    Write-Host $stdout.Result
  }
  finally {
    if ($null -ne $process) {
      try {
        if ($started -and -not $process.HasExited) {
          $process.Kill($true)
          [void]$process.WaitForExit(5000)
        }
      }
      finally { $process.Dispose() }
    }
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
  }
}
