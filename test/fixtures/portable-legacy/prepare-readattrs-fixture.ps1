#requires -Version 5.1
# TEST FIXTURE - SANITIZED - NOT PRODUCTION EVIDENCE.
# Derived from the legacy binding-generation regression shape; machine bindings were replaced.
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$MalformedTemplate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $SelfTest) { throw 'TEST_FIXTURE_SELFTEST_ONLY' }

function Replace-ExactlyOnce([string]$Source, [string]$Old, [string]$New, [string]$Code) {
    $first = $Source.IndexOf($Old, [StringComparison]::Ordinal)
    if ($first -lt 0) { throw $Code }
    if ($Source.IndexOf($Old, $first + $Old.Length, [StringComparison]::Ordinal) -ge 0) {
        throw $Code
    }
    return $Source.Substring(0, $first) + $New + $Source.Substring($first + $Old.Length)
}

$templatePath = Join-Path $PSScriptRoot 'Bindings.cs.in'
$template = [IO.File]::ReadAllText($templatePath)
if ($MalformedTemplate) {
    $template = $template.Replace('@@BRIDGE_SID@@', 'BROKEN_BINDING_POINT')
}
$rendered = Replace-ExactlyOnce $template '@@BRIDGE_SID@@' 'S-1-5-21-111-222-333-1004' 'BRIDGE_SID_BINDING_POINT'
$rendered = Replace-ExactlyOnce $rendered '@@CONTROLLER_HOME@@' 'C:\FixtureRoot\controller' 'CONTROLLER_HOME_BINDING_POINT'
$rendered = Replace-ExactlyOnce $rendered '@@INGRESS_ROOT@@' 'C:\FixtureRoot\ingress' 'INGRESS_ROOT_BINDING_POINT'
if ($rendered.Contains('@@')) { throw 'UNBOUND_FIXTURE_FIELD' }

[ordered]@{
    status = 'PASS'
    kind = 'SANITIZED_FIXTURE_BINDINGS'
    client_access = '0x00120003'
    bridge_allow_ace = '0x00120083'
    bindings = $rendered
} | ConvertTo-Json -Compress
