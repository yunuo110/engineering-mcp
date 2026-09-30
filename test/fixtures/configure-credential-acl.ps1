param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$CoreSid,
  [string]$ExtraSid,
  [switch]$Diagnostic
)
$ErrorActionPreference = 'Stop'
$resolved = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFileName($resolved).StartsWith('engineering-credential-acl-', [StringComparison]::Ordinal) -or
    -not (Test-Path -LiteralPath $resolved -PathType Container)) { throw 'TEST_ROOT_REFUSED' }
$blob = Join-Path $resolved 'bundle.blob'
if (-not (Test-Path -LiteralPath $blob -PathType Leaf)) { throw 'TEST_BLOB_REFUSED' }
$operator = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$core = [Security.Principal.SecurityIdentifier]::new($CoreSid)
if ($core.Value -eq $operator.Value -or $core.Value -eq $system.Value) { throw 'TEST_SID_COLLISION' }
$extra = if ($ExtraSid) { [Security.Principal.SecurityIdentifier]::new($ExtraSid) } else { $null }
function Set-TestAcl([string]$Path, [bool]$Directory) {
  $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() }
    else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($operator)
  foreach ($entry in @(@($operator, [Security.AccessControl.FileSystemRights]::FullControl),
      @($system, [Security.AccessControl.FileSystemRights]::FullControl),
      @($core, $(if ($Directory) { [Security.AccessControl.FileSystemRights]::ReadAndExecute }
        else { [Security.AccessControl.FileSystemRights]::Read })))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $entry[0], $entry[1], [Security.AccessControl.InheritanceFlags]::None,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow))
  }
  if ($extra -and -not $Directory) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $extra, [Security.AccessControl.FileSystemRights]::Read,
      [Security.AccessControl.InheritanceFlags]::None,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow))
  }
  if ($Directory) { [System.IO.Directory]::SetAccessControl($Path, $acl) }
  else { [System.IO.File]::SetAccessControl($Path, $acl) }
  return $acl
}
function Get-AceContract($Acl) {
  @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.IdentityReference.Value,
      [int]$_.FileSystemRights, $_.AccessControlType, $_.IsInherited,
      $_.InheritanceFlags, $_.PropagationFlags
  } | Sort-Object) -join ';'
}
function Read-VerifiedAcl([string]$Path, [bool]$Directory, $Expected) {
  $actual = if ($Directory) { [System.IO.Directory]::GetAccessControl($Path) }
    else { [System.IO.File]::GetAccessControl($Path) }
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $operator.Value -or
      -not $actual.AreAccessRulesProtected -or
      (Get-AceContract $actual) -cne (Get-AceContract $Expected)) { throw 'TEST_ACL_READBACK_REFUSED' }
  return $actual
}
function Record-Diagnostic([string]$Stage, [string]$Path, $Acl) {
  if ($Diagnostic) {
    [pscustomobject]@{
      Stage=$Stage; Path=$Path; Owner=$Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      Protected=$Acl.AreAccessRulesProtected; AceContract=(Get-AceContract $Acl)
      Sddl=$Acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
    } | ConvertTo-Json -Compress | Write-Output
  }
}
# Protect the existing child before removing the parent's inheritable entries.
# Any blob write/readback failure aborts before the root is sealed.
$blobExpected = Set-TestAcl $blob $false
$blobBefore = Read-VerifiedAcl $blob $false $blobExpected
Record-Diagnostic 'BLOB_FIRST_VERIFIED' $blob $blobBefore
$rootExpected = Set-TestAcl $resolved $true
$rootActual = Read-VerifiedAcl $resolved $true $rootExpected
Record-Diagnostic 'ROOT_LAST_VERIFIED' $resolved $rootActual
$blobAfter = Read-VerifiedAcl $blob $false $blobExpected
if ($blobBefore.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All) -cne
    $blobAfter.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)) {
  throw 'TEST_BLOB_DESCRIPTOR_CHANGED'
}
Record-Diagnostic 'BLOB_AFTER_ROOT_VERIFIED' $blob $blobAfter
Write-Output 'TEST_CREDENTIAL_ACL_CONFIGURED'
