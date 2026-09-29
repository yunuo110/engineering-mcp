param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$CoreSid,
  [string]$ExtraSid
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
  Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}
Set-TestAcl $resolved $true
Set-TestAcl $blob $false
Write-Output 'TEST_CREDENTIAL_ACL_CONFIGURED'
