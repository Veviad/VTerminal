$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-inference-smoke.ps1')

function Assert-Rejected([scriptblock]$Action) {
  $rejected = $false
  try { & $Action } catch { $rejected = $true }
  if (-not $rejected) { throw 'Expected inference evidence to be rejected.' }
}

$valid = @{
  ok = $true
  backend = 'cpu'
  mtp = @{ mode = 'mtp'; drafted_tokens = 6; completion_tokens = 12; backend = 'cpu' }
  standard = @{ mode = 'standard'; completion_tokens = 12; drafted_tokens = 0; backend = 'cpu' }
  repeated_mtp = @{ mode = 'mtp'; drafted_tokens = 6; completion_tokens = 12; backend = 'cpu' }
  chat = @{ mode = 'mtp'; drafted_tokens = 6; completion_tokens = 12; backend = 'cpu' }
  tool_result_round = @{ ok = $true; tool_calls = 1 }
  cancellation = @{ ok = $true; resumed = $true }
}
Assert-InferenceSmokeResult -Output ($valid | ConvertTo-Json) -ExpectedBackend cpu
Assert-Rejected { Assert-InferenceSmokeResult -Output ($valid | ConvertTo-Json) -ExpectedBackend vulkan }
$valid.mtp.mode = 'standard'
Assert-Rejected { Assert-InferenceSmokeResult -Output ($valid | ConvertTo-Json) -ExpectedBackend cpu }
$valid.mtp.mode = 'mtp'
$valid.mtp.drafted_tokens = 0
Assert-Rejected { Assert-InferenceSmokeResult -Output ($valid | ConvertTo-Json) -ExpectedBackend cpu }
$valid.mtp.drafted_tokens = 6
$valid.standard.completion_tokens = 0
Assert-Rejected { Assert-InferenceSmokeResult -Output ($valid | ConvertTo-Json) -ExpectedBackend cpu }
$valid.standard.completion_tokens = 12
$valid.repeated_mtp.backend = 'vulkan'
Assert-Rejected { Assert-InferenceSmokeResult -Output ($valid | ConvertTo-Json) -ExpectedBackend cpu }
$valid.repeated_mtp.backend = 'cpu'
$valid.chat.mode = 'standard'
Assert-Rejected { Assert-InferenceSmokeResult -Output ($valid | ConvertTo-Json) -ExpectedBackend cpu }
$valid.chat.mode = 'mtp'
$valid.tool_result_round.tool_calls = 0
Assert-Rejected { Assert-InferenceSmokeResult -Output ($valid | ConvertTo-Json) -ExpectedBackend cpu }
$valid.tool_result_round.tool_calls = 1
$valid.cancellation.resumed = $false
Assert-Rejected { Assert-InferenceSmokeResult -Output ($valid | ConvertTo-Json) -ExpectedBackend cpu }
Assert-Rejected { Assert-InferenceSmokeResult -Output '{"ok":true}' -ExpectedBackend cpu }
Write-Host 'Inference evidence validation: 10 cases passed.'
