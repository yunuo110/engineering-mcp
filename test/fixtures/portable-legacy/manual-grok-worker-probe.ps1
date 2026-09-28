#requires -Version 5.1
# TEST FIXTURE - SANITIZED - NOT PRODUCTION EVIDENCE.
# Derived from legacy regression shape; machine bindings intentionally replaced.
<#
Engineering MCP: manual Grok LOCAL PREFLIGHT, not a worker or a bridge.
No arbitrary executable/argv/cwd/prompt/config input. No model/auth invocation.
Run in the intended Engineering launch account and environment. A matching SID
alone does not prove matching elevation, environment, configuration or a live
C2C caller. EngineeringProcessId is an optional operator-selected live caller.
Only metadata JSON reaches stdout. No raw Grok output/config/auth is saved.
Review docs/grok-worker-local-probe.md before use. Do not change execution policy.
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 2147483647)][int]$EngineeringProcessId = 0,
    [switch]$SelfTest
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RepoRoot = 'C:\FixtureRoot\repo'

# These helpers project known metadata, never recursively copy an inspect object.
function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}
function Get-Shape($Value) {
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return 'string' }
    if ($Value -is [bool]) { return 'boolean' }
    if ($Value -is [System.Collections.IList]) { return 'array' }
    if ($Value -is [pscustomobject]) { return 'object' }
    if ($Value -is [ValueType]) { return 'number' }
    return 'other'
}
function Get-SafePath($Value) {
    if ($Value -isnot [string] -or $Value.Length -gt 1024) { return $null }
    # Path metadata only. Reject URLs, device/UNC paths, ADS and control data.
    if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2) -match '[:\x00-\x1f?*<>|]') { return $null }
    try { return [IO.Path]::GetFullPath($Value) } catch { return $null }
}
function Get-KnownLabel($Value) {
    # Unknown dynamic labels can themselves contain credentials. Do not print
    # them, even when they look like a harmless identifier. This is omission,
    # not a regex claim that arbitrary strings are secret-free.
    if ($Value -is [string] -and $Value -cin @('engineering-mcp','grok','user','project','managed','requirements','claude','cursor','plugin')) { return $Value }
    return 'OMITTED_UNREVIEWED_LABEL'
}
function Get-StderrCategory([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return 'NONE' }
    if ($Text -match '(?i)unknown (argument|option)|unexpected argument|unrecognized') { return 'ARGUMENT_ERROR' }
    if ($Text -match '(?i)authentication|unauthorized|not logged in|sign in required') { return 'AUTH_RELATED_REDACTED' }
    if ($Text -match '(?i)config|permission denied|access denied') { return 'CONFIG_OR_ACCESS_REDACTED' }
    return 'OTHER_REDACTED'
}
function Get-CapabilitySummary([string]$Text) {
    $flags = @('--no-auto-update','--single','--output-format','--model','--cwd','--permission-mode','--allow','--deny','--tools','--disallowed-tools','--max-turns','--no-memory','--no-subagents','--disable-web-search')
    $observed = @($flags | Where-Object { $Text -match ('(?<![\w-])' + [regex]::Escape($_) + '(?![\w-])') })
    return [ordered]@{ advertised_flags = $observed; json_format_mentioned = ($Text -match '\bjson\b'); streaming_json_mentioned = ($Text -match '\bstreaming-json\b'); semantic_support = 'NOT_PROVEN_BY_HELP' }
}
function Get-InspectSummary([string]$Text) {
    $summary = [ordered]@{ status = 'UNPARSEABLE'; schema_coverage = 'UNPROVEN'; sections = @(); unknown_root_fields = 0; owner_tools_reachable = 'UNPROVEN'; permission_mode = 'UNPROVEN'; model_selection = 'UNPROVEN' }
    try { $raw = ConvertFrom-Json -InputObject $Text -ErrorAction Stop } catch { return $summary }
    if ($raw -isnot [pscustomobject] -or -not $Text.TrimStart().StartsWith('{')) { return $summary }
    $summary.status = 'PARSED_METADATA_ONLY'
    $allowed = @('config_sources','sources','mcp_servers','mcps','plugins','hooks','skills','instructions','rules','permission_mode','effective_permission_mode','model','model_id')
    $names = @($raw.PSObject.Properties | ForEach-Object { $_.Name })
    $summary.unknown_root_fields = @($names | Where-Object { $_ -cnotin $allowed }).Count
    foreach ($key in $allowed) {
        if ($key -cnotin $names) { continue }
        $value = Get-Field $raw $key
        if ($key -in @('permission_mode','effective_permission_mode')) {
            if ($value -is [string] -and $value -cin @('ask','auto','always-approve','dontAsk','default','plan','acceptEdits')) { $summary.permission_mode = $value }
            continue
        }
        if ($key -in @('model','model_id')) {
            # A model value is needed before binding, but not trusted as a
            # secret-free label yet. Report its shape, not its opaque value.
            $summary.model_selection = 'PRESENT_BUT_NOT_PINNED'
            continue
        }
        $rows = @()
        $items = @()
        $shape = Get-Shape $value
        if ($shape -eq 'array') { $items = @($value) }
        elseif ($shape -eq 'object') {
            # Map keys are deliberately not emitted. Inspect versions may use
            # maps or arrays; unknown layout does not prove an empty toolset.
            $items = @($value.PSObject.Properties | ForEach-Object { $_.Value })
        }
        foreach ($item in @($items | Select-Object -First 64)) {
            $name = Get-Field $item 'name'
            if ($null -eq $name) { $name = Get-Field $item 'id' }
            $origin = Get-Field $item 'origin'
            $path = Get-SafePath (Get-Field $item 'path')
            if ($null -eq $path) { $path = Get-SafePath (Get-Field $item 'source_path') }
            if ($null -eq $path) { $path = Get-SafePath (Get-Field $item 'source') }
            if ($null -eq $path) { $path = Get-SafePath $origin }
            if ($null -eq $path) { $path = Get-SafePath (Get-Field $origin 'path') }
            if ($null -eq $path -and $item -is [string]) { $path = Get-SafePath $item }
            $rows += [ordered]@{ label = (Get-KnownLabel $name); source_path = $path; item_shape = (Get-Shape $item) }
        }
        $summary.sections += [ordered]@{ field = $key; shape = $shape; observed_item_count = $items.Count; truncated = ($items.Count -gt 64); entries = $rows }
    }
    # Do NOT turn an empty/missing section into OWNER isolation = NO.
    $raw = $null
    return $summary
}

# Native helper: canonical path and hash from the same open file; PE checks;
# bounded redirected pipes; a fixed command enumeration, not a command runner.
$NativeSource = @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
namespace EngineeringGrokLocalProbe {
 public sealed class Artifact {
  public string CanonicalPath; public string Sha256; public long Bytes; public int Machine;
 }
 public sealed class Capture {
  public int ExitCode = -1; public string Status = "NOT_STARTED";
  public string Out = ""; public string Err = ""; public bool OutputTruncated;
  public bool JobAssigned; public bool PipesClosed; public bool RootExited;
 }
 public enum Diagnostic { Help, Version, AgentHelp, StdioHelp, InspectHelp, Inspect }
 public static class Native {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder p, uint n, uint f);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j,int c,ref Limits l,int n);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct Basic {
   public long User, Job; public uint Flags; public UIntPtr Min,Max;
   public uint Count; public UIntPtr Affinity; public uint Priority,Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public IO IO; public UIntPtr A,B,C,D; }
  static string PathOf(FileStream f) {
   var b=new StringBuilder(32768); uint n=GetFinalPathNameByHandle(f.SafeFileHandle,b,(uint)b.Capacity,0);
   if(n==0 || n>=b.Capacity) throw new IOException("CANONICALIZATION_FAILED");
   string s=b.ToString(); if(s.StartsWith(@"\\?\UNC\")) throw new IOException("UNC_REJECTED");
   if(s.StartsWith(@"\\?\")) s=s.Substring(4); return s;
  }
  static string Hash(FileStream f) { f.Position=0; using(var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(f)).Replace("-","").ToLowerInvariant(); }
  public static Artifact ReadArtifact(string path) {
   using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
    if(f.Length<128 || f.Length>2147483648L) throw new IOException("INVALID_PE_SIZE");
    var r=new BinaryReader(f,Encoding.UTF8,true);
    if(r.ReadUInt16()!=0x5a4d) throw new IOException("NOT_PE");
    f.Position=60; uint pos=r.ReadUInt32();
    if(pos<64 || pos>f.Length-24) throw new IOException("NOT_PE");
    f.Position=pos; if(r.ReadUInt32()!=0x4550) throw new IOException("NOT_PE");
    int machine=r.ReadUInt16(); f.Position=pos+22; int flags=r.ReadUInt16();
    if((flags & 0x2000)!=0 || (flags & 2)==0) throw new IOException("NOT_PE_EXECUTABLE");
    return new Artifact {CanonicalPath=PathOf(f),Sha256=Hash(f),Bytes=f.Length,Machine=machine};
   }
  }
  public static string Arguments(Diagnostic d) {
   switch(d) {
    case Diagnostic.Help: return "--no-auto-update --help";
    case Diagnostic.Version: return "--no-auto-update version";
    case Diagnostic.AgentHelp: return "--no-auto-update agent --help";
    case Diagnostic.StdioHelp: return "--no-auto-update agent stdio --help";
    case Diagnostic.InspectHelp: return "--no-auto-update inspect --help";
    case Diagnostic.Inspect: return "--no-auto-update inspect --json";
    default: throw new ArgumentOutOfRangeException();
   }
  }
  public static Capture Run(string exe,string expectedHash,Diagnostic diagnostic,string cwd) {
   var result=new Capture(); Process p=null; IntPtr job=IntPtr.Zero;
   // Keeping this read-only shared handle open denies normal write/delete
   // replacement of the pinned executable while the diagnostic is running.
   using(var held=new FileStream(exe,FileMode.Open,FileAccess.Read,FileShare.Read)) {
    if(PathOf(held)!=exe || Hash(held)!=expectedHash) throw new IOException("ARTIFACT_DRIFT");
    try {
     job=CreateJobObject(IntPtr.Zero,null); var limits=new Limits(); limits.Basic.Flags=0x2000;
     if(job==IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(Limits)))) { result.Status="JOB_SETUP_FAILED"; return result; }
     var si=new ProcessStartInfo(exe,Arguments(diagnostic)); si.WorkingDirectory=cwd;
     si.UseShellExecute=false; si.CreateNoWindow=true;
     si.RedirectStandardInput=true; si.RedirectStandardOutput=true; si.RedirectStandardError=true;
     // No environment dump or credential access. Inherit the invoking context,
     // modifying only documented update/log controls for these diagnostics.
     si.EnvironmentVariables["GROK_DISABLE_AUTOUPDATER"]="1";
     si.EnvironmentVariables["GROK_CRASH_HANDLER"]="0";
     si.EnvironmentVariables.Remove("GROK_LOG_FILE"); si.EnvironmentVariables.Remove("RUST_LOG");
     p=Process.Start(si);
     result.JobAssigned=AssignProcessToJobObject(job,p.Handle);
     if(!result.JobAssigned) { result.Status="JOB_ASSIGN_FAILED"; try {p.Kill();} catch {} return result; }
     p.StandardInput.Close();
     int overflow=0; var output=new StringBuilder(); var error=new StringBuilder();
     Action<StreamReader,StringBuilder> pump=(reader,sink)=>{
      try {var buf=new char[2048];int n;while((n=reader.Read(buf,0,buf.Length))>0){
       if(sink.Length+n>1048576){Interlocked.Exchange(ref overflow,1);continue;} sink.Append(buf,0,n);
      }} catch {Interlocked.Exchange(ref overflow,1);}
     };
     var outTask=Task.Run(()=>pump(p.StandardOutput,output)); var errTask=Task.Run(()=>pump(p.StandardError,error));
     var watch=Stopwatch.StartNew();
     while(!p.WaitForExit(25) && watch.ElapsedMilliseconds<15000 && Volatile.Read(ref overflow)==0) {}
     if(!p.HasExited) { result.Status=Volatile.Read(ref overflow)!=0?"OUTPUT_LIMIT":"TIMEOUT"; try {p.Kill();} catch {} }
     else { result.ExitCode=p.ExitCode; result.Status="EXITED"; }
     // Close the job even after a normal root exit: inherited pipe handles
     // must not keep a child alive or make this diagnostic wait indefinitely.
     CloseHandle(job); job=IntPtr.Zero;
     result.RootExited=p.WaitForExit(2000);
     result.PipesClosed=Task.WaitAll(new Task[]{outTask,errTask},2000);
     result.OutputTruncated=Volatile.Read(ref overflow)!=0;
     if(!result.PipesClosed) {result.Status="PIPE_CLEANUP_UNPROVEN";return result;}
     result.Out=output.ToString();result.Err=error.ToString();
     if(result.OutputTruncated) result.Status="OUTPUT_LIMIT";
     return result;
    } finally {if(job!=IntPtr.Zero)CloseHandle(job);if(p!=null)p.Dispose();}
   }
  }
 }
}
'@

function Initialize-NativeHelper {
    if (-not ('EngineeringGrokLocalProbe.Native' -as [type])) { Add-Type -TypeDefinition $NativeSource -ErrorAction Stop }
}
function Invoke-OfflineSelfTest {
    $canary = 'NEVER_EXPORT_THIS_CREDENTIAL_4917'
    $raw = '{"config_sources":[{"path":"C:\\probe\\config.toml","token":"'+$canary+'"}],"mcp_servers":[{"name":"engineering-mcp","source":"C:\\probe\\config.toml","command":"'+$canary+'","headers":{"Authorization":"'+$canary+'"}},{"name":"'+$canary+'"}],"model":"'+$canary+'","env":{"key":"'+$canary+'"},"hooks":[{"name":"'+$canary+'","command":"'+$canary+'"}]}'
    $projected = Get-InspectSummary $raw
    $json = ConvertTo-Json -InputObject $projected -Depth 12 -Compress
    if ($json.Contains($canary)) { throw 'SELFTEST_SECRET_PROJECTION_FAILED' }
    if ($projected.owner_tools_reachable -ne 'UNPROVEN') { throw 'SELFTEST_FALSE_ISOLATION' }
    foreach ($sample in @('{}','[]','not json','{"mcp_servers":[]}',('{"mcp_servers":{"untrusted":{"env":{"password":"'+$canary+'"}}}}'))) {
        $s = Get-InspectSummary $sample
        if ($s.owner_tools_reachable -ne 'UNPROVEN' -or (ConvertTo-Json $s -Depth 12).Contains($canary)) { throw 'SELFTEST_UNKNOWN_SCHEMA_FAILED' }
    }
    if ($null -ne (Get-SafePath 'https://example.invalid/?token=x')) { throw 'SELFTEST_URL_PATH_FAILED' }
    if ($null -ne (Get-SafePath 'C:\probe\config.toml:token')) { throw 'SELFTEST_ADS_FAILED' }
    $c = Get-CapabilitySummary '--no-auto-update --output-format plain json streaming-json'
    if ('--no-auto-update' -notin $c.advertised_flags -or -not $c.streaming_json_mentioned) { throw 'SELFTEST_CAPABILITIES_FAILED' }
    Initialize-NativeHelper
    foreach ($d in [Enum]::GetValues([EngineeringGrokLocalProbe.Diagnostic])) {
        $a = [EngineeringGrokLocalProbe.Native]::Arguments($d)
        if (-not $a.StartsWith('--no-auto-update ') -or $a -match '(^| )-p |always-approve|login|authenticate|session/prompt') { throw 'SELFTEST_FIXED_COMMANDS_FAILED' }
    }
    # No Windows process, Grok binary, filesystem inventory or authentication
    # code is invoked in this branch. CI runs this branch only.
    return [ordered]@{ status='PASS'; kind='OFFLINE_PROJECTION_AND_FIXED_COMMAND_TEST'; grok_invocations=0; live_auth_tested=$false; live_isolation_tested=$false }
}
if ($SelfTest) {
    try { Invoke-OfflineSelfTest | ConvertTo-Json -Depth 6; exit 0 }
    catch { [Console]::Out.WriteLine('{"status":"FAIL","kind":"OFFLINE_SELFTEST","details":"OMITTED"}'); exit 1 }
}

$report = [ordered]@{
    report_version='grok-local-preflight/1'; scope='LOCAL_METADATA_ONLY_NOT_CONTRACT_CLOSURE'; generated_at_utc=[DateTime]::UtcNow.ToString('o');
    worker_identity=[ordered]@{ probe_account=$null; probe_sid=$null; selected_launcher_pid=$EngineeringProcessId; selected_launcher_sid=$null; selected_launcher_name=$null; selected_launcher_creation_time=$null; same_sid=$null; binding='UNPROVEN'; environment_equivalence='UNPROVEN'; elevation_equivalence='UNPROVEN' };
    discovery_scope='current process PATH grok.exe + current user .grok/bin/grok.exe + GROK_BIN_DIR/grok.exe; no recursive disk scan';
    discovery_complete=$true; candidates=@(); selection=$null; probes=@();
    diagnostic_environment_overrides=@('GROK_DISABLE_AUTOUPDATER=1','GROK_CRASH_HANDLER=0','GROK_LOG_FILE omitted','RUST_LOG omitted');
    grok_home=[ordered]@{ inherited_path=$null; mutated=$false; credential_files_read_by_script=$false; runtime_credential_access='NOT_OBSERVED' };
    config_isolation=[ordered]@{ owner_tools_reachable='UNPROVEN'; actual_task_cwd='UNPROVEN'; inspected_cwd=$RepoRoot; note='Development cwd metadata is not a disposable task or a future worker isolation proof' };
    authentication=[ordered]@{ verdict='DEFER'; status='NOT_RUN_ISOLATION_GATE'; method_names=@(); };
    headless=[ordered]@{ status='NOT_RUN_ISOLATION_GATE'; model_calls=0 };
    acp=[ordered]@{ status='NOT_RUN_ISOLATION_GATE'; initialized=$false; authenticated=$false; session_created=$false; required_methods='UNPROVEN' };
    permissions='UNPROVEN'; model_pin='UNPROVEN'; windows_sandbox='UNPROVEN'; real_grok_e2e='NOT_RUN';
    enablement='HOLD'; blockers=@('OWNER_TOOL_ISOLATION_UNPROVEN','AUTH_NOT_TESTED','REAL_TASK_METHOD_SET_UNKNOWN','MODEL_NOT_PINNED');
    raw_streams_saved=$false; config_or_auth_files_copied=$false; production_mutation_requested=$false; production_mutation_observed='NOT_MEASURED';
    limitations=@('No whole-machine installation census','No arbitrary labels/model values emitted','Inspect schema coverage is partial and never proves absence','Job assignment occurs after process start, not an atomic prevention sandbox','The CLI itself may create diagnostic/cache files; filesystem-wide side effects are not measured');
}
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_REQUIRED' }
    Initialize-NativeHelper
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $report.worker_identity.probe_account=$identity.Name
    $report.worker_identity.probe_sid=$identity.User.Value
    if ($EngineeringProcessId -gt 0) {
        # Read only process identity metadata, not command lines or environments.
        $p = Get-CimInstance Win32_Process -Filter ('ProcessId = '+$EngineeringProcessId) -Property ProcessId,Name,CreationDate -ErrorAction Stop
        if ($null -eq $p) { throw 'LAUNCHER_NOT_FOUND' }
        $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop
        if ($owner.ReturnValue -ne 0) { throw 'LAUNCHER_OWNER_UNAVAILABLE' }
        $report.worker_identity.selected_launcher_sid=$owner.Sid
        $report.worker_identity.selected_launcher_name=$p.Name
        $report.worker_identity.selected_launcher_creation_time=[string]$p.CreationDate
        $report.worker_identity.same_sid=($owner.Sid -eq $identity.User.Value)
        $report.worker_identity.binding='OPERATOR_SELECTED_LIVE_PROCESS_SID_ONLY_NOT_CALLER_ATTESTATION'
        if (-not $report.worker_identity.same_sid) { $report.blockers += 'PROBE_LAUNCHER_SID_MISMATCH' }
    } else { $report.blockers += 'NO_ACTUAL_LAUNCHER_PID_BOUND' }
    $homePath = $env:GROK_HOME
    if ([string]::IsNullOrEmpty($homePath)) { $homePath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.grok' }
    $report.grok_home.inherited_path=Get-SafePath $homePath
    $roots = @($env:PATH -split ';') + @((Join-Path ([Environment]::GetFolderPath('UserProfile')) '.grok\bin'))
    if (-not [string]::IsNullOrEmpty($env:GROK_BIN_DIR)) { $roots += $env:GROK_BIN_DIR }
    $unique = @{}; $seenPaths=@{}
    foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $safeRoot=Get-SafePath ($root.Trim().Trim('"'))
        if ($null -eq $safeRoot) { $report.discovery_complete=$false; continue }
        $candidate=Join-Path $safeRoot 'grok.exe'
        if ($seenPaths.ContainsKey($candidate)) { continue }; $seenPaths[$candidate]=$true
        if ($seenPaths.Count -gt 256) { $report.discovery_complete=$false; break }
        try { $attrs=[IO.File]::GetAttributes($candidate) }
        catch [IO.FileNotFoundException] { continue }
        catch [IO.DirectoryNotFoundException] { continue }
        catch { $report.discovery_complete=$false; continue }
        if (($attrs -band [IO.FileAttributes]::Directory) -ne 0) { $report.discovery_complete=$false; continue }
        try {
            $a=[EngineeringGrokLocalProbe.Native]::ReadArtifact($candidate)
            $report.candidates += [ordered]@{ discovered_path=$candidate; canonical_path=$a.CanonicalPath; sha256=$a.Sha256; file_type='PE_EXECUTABLE'; pe_machine=$a.Machine; bytes=$a.Bytes }
            $unique[$a.CanonicalPath]=$a
        } catch { $report.candidates += [ordered]@{ discovered_path=$candidate; status='UNREADABLE_OR_NOT_PE'; details='OMITTED' }; $report.discovery_complete=$false }
    }
    if (-not $report.discovery_complete -or $unique.Count -ne 1) {
        $report.blockers += 'ARTIFACT_SELECTION_AMBIGUOUS_MISSING_OR_DISCOVERY_INCOMPLETE'
    } elseif ($report.worker_identity.same_sid -eq $false) {
        $report.blockers += 'DIAGNOSTICS_NOT_RUN_UNDER_WRONG_IDENTITY'
    } else {
        $selected=@($unique.Values)[0]
        $report.selection=[ordered]@{ canonical_path=$selected.CanonicalPath; sha256=$selected.Sha256; selection_rule='ONLY_UNIQUE_CANONICAL_CANDIDATE_IN_DECLARED_SCOPE'; verified_for='THIS_PROBE_CONTEXT_ONLY'; version=$null; version_base=$null; full_version_known=$false }
        if (-not [IO.Directory]::Exists($RepoRoot)) { throw 'FIXED_REPO_CWD_UNAVAILABLE' }
        $helpAccepted=$false
        $diagnostics=@([EngineeringGrokLocalProbe.Diagnostic]::Help,[EngineeringGrokLocalProbe.Diagnostic]::Version,[EngineeringGrokLocalProbe.Diagnostic]::AgentHelp,[EngineeringGrokLocalProbe.Diagnostic]::StdioHelp,[EngineeringGrokLocalProbe.Diagnostic]::InspectHelp,[EngineeringGrokLocalProbe.Diagnostic]::Inspect)
        foreach ($kind in $diagnostics) {
            if ($kind -ne [EngineeringGrokLocalProbe.Diagnostic]::Help -and -not $helpAccepted) { break }
            $capture=[EngineeringGrokLocalProbe.Native]::Run($selected.CanonicalPath,$selected.Sha256,$kind,$RepoRoot)
            $entry=[ordered]@{ diagnostic=[string]$kind; argv_contract=[EngineeringGrokLocalProbe.Native]::Arguments($kind); status=$capture.Status; exit_code=$capture.ExitCode; stderr_category=(Get-StderrCategory $capture.Err); stdout_characters=$capture.Out.Length; output_truncated=$capture.OutputTruncated; job_assigned=$capture.JobAssigned; root_exited=$capture.RootExited; pipes_closed=$capture.PipesClosed }
            if ($kind -in @([EngineeringGrokLocalProbe.Diagnostic]::Help,[EngineeringGrokLocalProbe.Diagnostic]::AgentHelp,[EngineeringGrokLocalProbe.Diagnostic]::StdioHelp,[EngineeringGrokLocalProbe.Diagnostic]::InspectHelp)) {
                $entry.capabilities=Get-CapabilitySummary $capture.Out
            }
            if ($kind -eq [EngineeringGrokLocalProbe.Diagnostic]::Help) {
                $helpAccepted=($capture.Status -eq 'EXITED' -and $capture.ExitCode -eq 0 -and '--no-auto-update' -in $entry.capabilities.advertised_flags)
                if (-not $helpAccepted) { $report.blockers += 'NO_AUTO_UPDATE_LOCAL_SUPPORT_NOT_CONFIRMED' }
            }
            if ($kind -eq [EngineeringGrokLocalProbe.Diagnostic]::Version -and $capture.ExitCode -eq 0) {
                $v=[regex]::Match($capture.Out,'(?im)^\s*(?:grok(?:[ -](?:build|cli))?(?: version)?\s+)?v?(\d{1,4}\.\d{1,4}\.\d{1,4})(?<suffix>[-+][A-Za-z0-9.-]+)?\s*$')
                if ($v.Success) {
                    $report.selection.version_base=$v.Groups[1].Value
                    if (-not $v.Groups['suffix'].Success) { $report.selection.version=$v.Groups[1].Value; $report.selection.full_version_known=$true }
                    else { $report.blockers += 'VERSION_SUFFIX_OMITTED_REQUIRES_REVIEW' }
                } else { $report.blockers += 'VERSION_OUTPUT_UNRECOGNIZED' }
            }
            if ($kind -eq [EngineeringGrokLocalProbe.Diagnostic]::Inspect -and $capture.Status -eq 'EXITED' -and $capture.ExitCode -eq 0) { $entry.metadata=Get-InspectSummary $capture.Out }
            $capture.Out=''; $capture.Err=''; $capture=$null
            $report.probes += $entry
            $again=[EngineeringGrokLocalProbe.Native]::ReadArtifact($selected.CanonicalPath)
            if ($again.CanonicalPath -cne $selected.CanonicalPath -or $again.Sha256 -cne $selected.Sha256) { throw 'ARTIFACT_DRIFT' }
            if ($entry.status -ne 'EXITED') { $report.blockers += 'DIAGNOSTIC_PROCESS_OR_CLEANUP_FAILED'; break }
        }
    }
} catch {
    # Never emit exception.Message, ErrorRecord, stack, raw inspect or stderr.
    $report.blockers += 'LOCAL_PREFLIGHT_INCOMPLETE_DETAILS_OMITTED'
}
# Hard gate: this first-stage artifact cannot enable a model path. It has no
# login, ACP session, headless prompt, file edit, bridge deployment or bypass.
$report | ConvertTo-Json -Depth 14
