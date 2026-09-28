[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Witness,
  [Parameter(Mandatory)][string]$DispatchRunId,
  [Parameter(Mandatory)][string]$RunnerInstanceId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$bootstrap = [ordered]@{
  version = 1
  state = 'BOOTSTRAPPING'
  dispatch_run_id = $DispatchRunId
  runner_instance_id = $RunnerInstanceId
}
[IO.File]::WriteAllText($Witness, ($bootstrap | ConvertTo-Json -Compress),
  [Text.UTF8Encoding]::new($false))
