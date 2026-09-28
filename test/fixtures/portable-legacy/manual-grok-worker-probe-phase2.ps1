#requires -Version 5.1
# TEST FIXTURE - SANITIZED - NOT PRODUCTION EVIDENCE.
# Derived from legacy regression shape; machine bindings intentionally replaced.
<#
Engineering MCP: Grok Worker Enablement Phase-2 LOCAL METADATA probe.

This probe consumes the exact canonical grok.exe path + SHA-256 from the already
completed Phase-1 probe. It performs NO PATH discovery and has no fallback target.

It never calls a model, authenticates, creates an ACP session, mutates the repo,
or emits raw help/inspect/config/credential data.

Live Grok argv is a fixed enumeration only:
  --no-auto-update version
  --no-auto-update agent --help
  --no-auto-update agent stdio --help
  --no-auto-update inspect --help
  --no-auto-update inspect --json

The Phase1CanonicalPath/Phase1Sha256 parameters are artifact identity inputs,
not arbitrary Grok argv. Copy them only from the reviewed Phase-1 result.
#>
[CmdletBinding()]
param(
    [string]$Phase1CanonicalPath = '',
    [string]$Phase1Sha256 = '',
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$FixedCwd = 'C:\FixtureRoot\repo'

function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Get-SafeLocalPath($Value) {
    if ($Value -isnot [string] -or $Value.Length -gt 1024) { return $null }
    if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2) -match '[:\x00-\x1f?*<>|]') { return $null }
    try { return [IO.Path]::GetFullPath($Value) } catch { return $null }
}

function Get-SafeOriginLabel($Value) {
    if ($Value -isnot [string]) { return $null }
    $known = @(
        'user','project','managed','requirements','plugin','builtin','system',
        'claude','cursor','workspace','global','local'
    )
    if ($Value -cin $known) { return $Value.ToLowerInvariant() }
    return $null
}

function Get-SafePermissionMode($Value) {
    if ($Value -isnot [string]) { return $null }
    $known = @('ask','auto','always-approve','dontAsk','default','plan','acceptEdits')
    if ($Value -cin $known) { return $Value }
    return $null
}

function Get-SafeModelId($Value) {
    if ($Value -isnot [string] -or $Value.Length -lt 1 -or $Value.Length -gt 256) { return $null }
    # Format validation only. The field name itself supplies the non-secret
    # semantics; this regex is NOT a secret detector.
    if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$') { return $null }
    return $Value
}

function Get-PathFingerprint([string]$CanonicalPath) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($CanonicalPath.ToLowerInvariant())
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-StderrCategory([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return 'NONE' }
    if ($Text -match '(?i)unknown (argument|option)|unexpected argument|unrecognized') { return 'ARGUMENT_ERROR' }
    if ($Text -match '(?i)authentication|unauthorized|not logged in|sign in required') { return 'AUTH_RELATED_REDACTED' }
    if ($Text -match '(?i)permission denied|access denied') { return 'ACCESS_RELATED_REDACTED' }
    return 'OTHER_REDACTED'
}

function Test-HelpToken([string]$Text, [string]$Token) {
    return ($Text -match ('(?i)(?<![\w-])' + [regex]::Escape($Token) + '(?![\w-])'))
}

function Get-VersionProjection([string]$Stdout, [string]$Stderr) {
    $text = $Stdout + [Environment]::NewLine + $Stderr
    $matches = [regex]::Matches(
        $text,
        '(?im)^\s*(?:grok(?:[ -](?:build|cli))?(?: version)?\s+)?v?(?<version>\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]+)?)\s*$'
    )
    $versions = @($matches | ForEach-Object { $_.Groups['version'].Value } | Select-Object -Unique)
    if ($versions.Count -eq 1) { return $versions[0] }
    return 'UNKNOWN'
}

function Get-CollectionItems($Value) {
    if ($Value -is [System.Collections.IList]) {
        return [ordered]@{ supported=$true; items=@($Value); keys=@() }
    }
    if ($Value -is [pscustomobject]) {
        $props = @($Value.PSObject.Properties)
        return [ordered]@{
            supported=$true
            items=@($props | ForEach-Object { $_.Value })
            keys=@($props | ForEach-Object { $_.Name })
        }
    }
    return [ordered]@{ supported=$false; items=@(); keys=@() }
}

function Get-ItemOrigin($Item) {
    if ($null -eq $Item) { return $null }
    foreach ($field in @('origin','source_type','type')) {
        $value = Get-Field $Item $field
        if ($value -is [pscustomobject]) { $value = Get-Field $value 'type' }
        $safe = Get-SafeOriginLabel $value
        if ($null -ne $safe) { return $safe }
    }
    return $null
}

function Get-ItemPath($Item) {
    if ($null -eq $Item) { return $null }
    foreach ($field in @('path','source_path')) {
        $safe = Get-SafeLocalPath (Get-Field $Item $field)
        if ($null -ne $safe) { return $safe }
    }
    return $null
}

function New-SectionProjection($Value, [string]$Kind, [bool]$AllowPaths, [bool]$AllowReviewedNames) {
    $collection = Get-CollectionItems $Value
    if (-not $collection.supported) {
        return [ordered]@{ count=$null; origin_categories=@(); reviewed_names=@(); origin_paths=@(); coverage='PARTIAL' }
    }

    $origins = @()
    $names = @()
    $paths = @()
    $items = @($collection.items)
    for ($i=0; $i -lt $items.Count -and $i -lt 128; $i++) {
        $item = $items[$i]
        $origin = Get-ItemOrigin $item
        if ($null -ne $origin) { $origins += $origin }

        if ($AllowPaths) {
            $path = Get-ItemPath $item
            if ($null -ne $path) { $paths += $path }
        }

        if ($AllowReviewedNames) {
            $candidate = $null
            if ($i -lt $collection.keys.Count) { $candidate = $collection.keys[$i] }
            if ($null -eq $candidate -and $item -is [pscustomobject]) {
                $candidate = Get-Field $item 'name'
                if ($null -eq $candidate) { $candidate = Get-Field $item 'id' }
            }
            # Only explicitly reviewed non-secret MCP names are emitted.
            if ($candidate -is [string] -and $candidate -ceq 'engineering-mcp') {
                $names += $candidate
            }
        }
    }

    return [ordered]@{
        count=$items.Count
        origin_categories=@($origins | Select-Object -Unique | Sort-Object)
        reviewed_names=@($names | Select-Object -Unique | Sort-Object)
        origin_paths=@($paths | Select-Object -Unique | Sort-Object)
        coverage= if ($items.Count -gt 128) { 'PARTIAL' } else { 'PROJECTED' }
    }
}

function Get-ConfigOrigins($Value) {
    $collection = Get-CollectionItems $Value
    if (-not $collection.supported) {
        return [ordered]@{ count=$null; entries=@(); coverage='PARTIAL' }
    }
    $entries = @()
    $items = @($collection.items)
    foreach ($item in @($items | Select-Object -First 128)) {
        $origin = Get-ItemOrigin $item
        $path = Get-ItemPath $item
        if ($null -ne $origin -or $null -ne $path) {
            $entries += [ordered]@{
                source_type=$origin
                source_path=$path
            }
        }
    }
    return [ordered]@{
        count=$items.Count
        entries=$entries
        coverage= if ($items.Count -gt 128) { 'PARTIAL' } else { 'PROJECTED' }
    }
}

function Get-CompatibilityProjection($Raw) {
    $result = [ordered]@{ claude=$null; cursor=$null }
    foreach ($rootName in @('compat_sources','compatibility')) {
        $value = Get-Field $Raw $rootName
        if ($value -isnot [pscustomobject]) { continue }
        foreach ($name in @('claude','cursor')) {
            $candidate = Get-Field $value $name
            if ($candidate -is [bool]) { $result[$name] = $candidate }
            elseif ($candidate -is [pscustomobject]) {
                $enabled = Get-Field $candidate 'enabled'
                if ($enabled -is [bool]) { $result[$name] = $enabled }
            }
        }
    }
    return $result
}

function Get-SanitizedInspectProjection([string]$Text) {
    $projection = [ordered]@{
        coverage='UNKNOWN'
        config_origins=[ordered]@{ count=$null; entries=@(); coverage='UNKNOWN' }
        mcp=[ordered]@{ count=$null; origin_categories=@(); reviewed_names=@(); coverage='UNKNOWN' }
        plugins=[ordered]@{ count=$null; origin_categories=@(); coverage='UNKNOWN' }
        hooks=[ordered]@{ count=$null; origin_categories=@(); coverage='UNKNOWN' }
        skills=[ordered]@{ count=$null; origin_categories=@(); origin_paths=@(); coverage='UNKNOWN' }
        instructions=[ordered]@{ count=$null; origin_categories=@(); origin_paths=@(); coverage='UNKNOWN' }
        permission_mode=$null
        model=$null
        compatibility=[ordered]@{ claude=$null; cursor=$null }
    }

    try { $raw = ConvertFrom-Json -InputObject $Text -ErrorAction Stop } catch { return $projection }
    if ($raw -isnot [pscustomobject] -or -not $Text.TrimStart().StartsWith('{')) { return $projection }

    # The installed inspect schema is not frozen by Engineering MCP. Even when
    # parsing succeeds, this whitelist projection is intentionally PARTIAL.
    $projection.coverage = 'PARTIAL'
    $rootNames = @($raw.PSObject.Properties | ForEach-Object { $_.Name })

    $configValue = Get-Field $raw 'config_sources'
    if ($null -eq $configValue) { $configValue = Get-Field $raw 'sources' }
    if ($null -ne $configValue) { $projection.config_origins = Get-ConfigOrigins $configValue }

    $mcpValue = Get-Field $raw 'mcp_servers'
    if ($null -eq $mcpValue) { $mcpValue = Get-Field $raw 'mcps' }
    if ($null -ne $mcpValue) {
        $section = New-SectionProjection $mcpValue 'mcp' $false $true
        $projection.mcp = [ordered]@{
            count=$section.count
            origin_categories=$section.origin_categories
            reviewed_names=$section.reviewed_names
            coverage=$section.coverage
        }
    }

    foreach ($name in @('plugins','hooks')) {
        $value = Get-Field $raw $name
        if ($null -ne $value) {
            $section = New-SectionProjection $value $name $false $false
            $projection[$name] = [ordered]@{
                count=$section.count
                origin_categories=$section.origin_categories
                coverage=$section.coverage
            }
        }
    }

    foreach ($name in @('skills','instructions')) {
        $value = Get-Field $raw $name
        if ($null -ne $value) {
            $section = New-SectionProjection $value $name $true $false
            $projection[$name] = [ordered]@{
                count=$section.count
                origin_categories=$section.origin_categories
                origin_paths=$section.origin_paths
                coverage=$section.coverage
            }
        }
    }

    foreach ($name in @('effective_permission_mode','permission_mode')) {
        if ($name -cin $rootNames) {
            $safe = Get-SafePermissionMode (Get-Field $raw $name)
            if ($null -ne $safe) { $projection.permission_mode = $safe; break }
        }
    }

    foreach ($name in @('model_id','model')) {
        if ($name -cin $rootNames) {
            $safe = Get-SafeModelId (Get-Field $raw $name)
            if ($null -ne $safe) { $projection.model = $safe; break }
        }
    }

    $projection.compatibility = Get-CompatibilityProjection $raw
    $raw = $null
    return $projection
}

function Get-Capabilities(
    [bool]$VersionAccepted,
    [bool]$AgentAccepted,
    [bool]$StdioAccepted,
    [string]$AgentHelp,
    [string]$StdioHelp
) {
    $help = $AgentHelp + [Environment]::NewLine + $StdioHelp
    return [ordered]@{
        supports_agent=$AgentAccepted
        supports_agent_stdio=$StdioAccepted
        supports_no_auto_update_invocation=$VersionAccepted
        supports_model_flag=(Test-HelpToken $help '--model')
        supports_cwd_flag=(Test-HelpToken $help '--cwd')
        supports_permission_mode=(Test-HelpToken $help '--permission-mode')
        supports_allow=(Test-HelpToken $help '--allow')
        supports_deny=(Test-HelpToken $help '--deny')
        supports_tools=(Test-HelpToken $help '--tools')
        supports_disallowed_tools=(Test-HelpToken $help '--disallowed-tools')
        supports_max_turns=(Test-HelpToken $help '--max-turns')
        supports_no_subagents=(Test-HelpToken $help '--no-subagents')
        supports_disable_web_search=(Test-HelpToken $help '--disable-web-search')
        supports_output_json=((Test-HelpToken $help '--output-format') -and ($help -match '(?i)\bjson\b'))
        supports_streaming_json=($help -match '(?i)\b(?:streaming-json|stream-json)\b')
    }
}

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

namespace EngineeringGrokPhase2 {
 public sealed class Artifact {
  public string CanonicalPath; public string Sha256; public long Bytes; public int Machine;
 }
 public sealed class Capture {
  public int ExitCode=-1; public string Status="NOT_STARTED";
  public string Out=""; public string Err=""; public bool OutputTruncated;
  public bool JobAssigned; public bool RootExited; public bool PipesClosed;
 }
 public enum Diagnostic { Version, AgentHelp, StdioHelp, InspectHelp, Inspect }

 public static class Native {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder p,uint n,uint f);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll")]
  static extern bool SetInformationJobObject(IntPtr j,int c,ref Limits l,int n);
  [DllImport("kernel32.dll")]
  static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential)] struct Basic {
   public long User,Job; public uint Flags; public UIntPtr Min,Max;
   public uint Count; public UIntPtr Affinity; public uint Priority,Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
   public Basic Basic; public IO IO; public UIntPtr A,B,C,D;
  }

  static string PathOf(FileStream f) {
   var b=new StringBuilder(32768);
   uint n=GetFinalPathNameByHandle(f.SafeFileHandle,b,(uint)b.Capacity,0);
   if(n==0 || n>=b.Capacity) throw new IOException("CANONICALIZATION_FAILED");
   string s=b.ToString();
   if(s.StartsWith(@"\\?\UNC\")) throw new IOException("UNC_REJECTED");
   if(s.StartsWith(@"\\?\")) s=s.Substring(4);
   return s;
  }

  static string Hash(FileStream f) {
   f.Position=0;
   using(var h=SHA256.Create())
    return BitConverter.ToString(h.ComputeHash(f)).Replace("-","").ToLowerInvariant();
  }

  public static Artifact ReadArtifact(string path) {
   using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
    if(f.Length<128 || f.Length>2147483648L) throw new IOException("INVALID_PE_SIZE");
    var r=new BinaryReader(f,Encoding.UTF8,true);
    if(r.ReadUInt16()!=0x5a4d) throw new IOException("NOT_PE");
    f.Position=60; uint pos=r.ReadUInt32();
    if(pos<64 || pos>f.Length-24) throw new IOException("NOT_PE");
    f.Position=pos;
    if(r.ReadUInt32()!=0x4550) throw new IOException("NOT_PE");
    int machine=r.ReadUInt16();
    f.Position=pos+22; int flags=r.ReadUInt16();
    if((flags & 0x2000)!=0 || (flags & 2)==0) throw new IOException("NOT_PE_EXECUTABLE");
    if(machine!=0x8664) throw new IOException("NOT_X64");
    return new Artifact {
      CanonicalPath=PathOf(f), Sha256=Hash(f), Bytes=f.Length, Machine=machine
    };
   }
  }

  public static string Arguments(Diagnostic d) {
   switch(d) {
    case Diagnostic.Version: return "--no-auto-update version";
    case Diagnostic.AgentHelp: return "--no-auto-update agent --help";
    case Diagnostic.StdioHelp: return "--no-auto-update agent stdio --help";
    case Diagnostic.InspectHelp: return "--no-auto-update inspect --help";
    case Diagnostic.Inspect: return "--no-auto-update inspect --json";
    default: throw new ArgumentOutOfRangeException();
   }
  }

  public static Capture Run(string exe,string expectedHash,Diagnostic diagnostic,string cwd) {
   var result=new Capture();
   Process p=null; IntPtr job=IntPtr.Zero;
   using(var held=new FileStream(exe,FileMode.Open,FileAccess.Read,FileShare.Read)) {
    if(!String.Equals(PathOf(held),exe,StringComparison.OrdinalIgnoreCase) ||
       !String.Equals(Hash(held),expectedHash,StringComparison.OrdinalIgnoreCase))
      throw new IOException("ARTIFACT_CHANGED");

    try {
     job=CreateJobObject(IntPtr.Zero,null);
     var limits=new Limits(); limits.Basic.Flags=0x2000;
     if(job==IntPtr.Zero ||
        !SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(Limits)))) {
       result.Status="JOB_SETUP_FAILED"; return result;
     }

     var si=new ProcessStartInfo(exe,Arguments(diagnostic));
     si.WorkingDirectory=cwd;
     si.UseShellExecute=false;
     si.CreateNoWindow=true;
     si.RedirectStandardInput=true;
     si.RedirectStandardOutput=true;
     si.RedirectStandardError=true;
     si.EnvironmentVariables["GROK_DISABLE_AUTOUPDATER"]="1";
     si.EnvironmentVariables["GROK_CRASH_HANDLER"]="0";
     si.EnvironmentVariables.Remove("GROK_LOG_FILE");
     si.EnvironmentVariables.Remove("RUST_LOG");

     p=Process.Start(si);
     result.JobAssigned=AssignProcessToJobObject(job,p.Handle);
     if(!result.JobAssigned) {
       result.Status="JOB_ASSIGN_FAILED";
       try { p.Kill(); } catch {}
       return result;
     }

     p.StandardInput.Close();
     int overflow=0;
     var output=new StringBuilder();
     var error=new StringBuilder();

     Action<StreamReader,StringBuilder> pump=(reader,sink)=>{
      try {
       var buf=new char[2048]; int n;
       while((n=reader.Read(buf,0,buf.Length))>0) {
        if(sink.Length+n>1048576) {
         int keep=Math.Max(0,1048576-sink.Length);
         if(keep>0) sink.Append(buf,0,keep);
         Interlocked.Exchange(ref overflow,1);
         break;
        }
        sink.Append(buf,0,n);
       }
      } catch {}
     };

     var t1=Task.Factory.StartNew(()=>pump(p.StandardOutput,output));
     var t2=Task.Factory.StartNew(()=>pump(p.StandardError,error));
     var watch=Stopwatch.StartNew();

     while(!p.HasExited && watch.ElapsedMilliseconds<15000 && overflow==0)
      Thread.Sleep(25);

     if(!p.HasExited || overflow!=0) {
      result.Status=overflow!=0 ? "OUTPUT_LIMIT" : "TIMEOUT";
      try { p.Kill(); } catch {}
     } else {
      result.RootExited=true;
      result.ExitCode=p.ExitCode;
      result.Status="EXITED";
     }

     if(!Task.WaitAll(new[]{t1,t2},3000)) result.Status="PIPE_CLEANUP_UNPROVEN";
     else result.PipesClosed=true;

     result.OutputTruncated=overflow!=0;
     result.Out=output.ToString();
     result.Err=error.ToString();
     return result;
    } finally {
     if(job!=IntPtr.Zero) CloseHandle(job);
     if(p!=null) p.Dispose();
    }
   }
  }
 }
}
'@

function Initialize-NativeHelper {
    if (-not ('EngineeringGrokPhase2.Native' -as [type])) {
        Add-Type -TypeDefinition $NativeSource -Language CSharp
    }
}

function Test-IdentityMatch([string]$ExpectedPath,[string]$ExpectedHash,[string]$ActualPath,[string]$ActualHash) {
    return (
        [string]::Equals($ExpectedPath,$ActualPath,[StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($ExpectedHash,$ActualHash,[StringComparison]::OrdinalIgnoreCase)
    )
}

function Invoke-OfflineSelfTest {
    $canary = 'NEVER_EXPORT_PHASE2_SECRET_7719'
    $synthetic = @"
{
  "config_sources":[{"type":"user","path":"C:\\safe\\config.toml","token":"$canary"}],
  "mcp_servers":{"engineering-mcp":{"origin":"project","command":"$canary","headers":{"authorization":"$canary"}}},
  "plugins":[{"origin":"user","config":{"token":"$canary"}}],
  "hooks":[{"origin":"project","body":"$canary"}],
  "skills":[{"origin":"user","path":"C:\\safe\\skills\\one"}],
  "instructions":[{"origin":"project","path":"C:\\safe\\instructions.md"}],
  "permission_mode":"ask",
  "model_id":"grok-synthetic-model",
  "compat_sources":{"claude":true,"cursor":{"enabled":false}},
  "unknown_secret_root":"$canary"
}
"@
    $projection = Get-SanitizedInspectProjection $synthetic
    $json = ConvertTo-Json -InputObject $projection -Depth 12 -Compress
    if ($json.Contains($canary)) { throw 'SELFTEST_SECRET_LEAK' }
    if ($projection.coverage -ne 'PARTIAL') { throw 'SELFTEST_COVERAGE_PROMOTION' }
    if ($projection.mcp.count -ne 1) { throw 'SELFTEST_MCP_COUNT' }
    if (@($projection.mcp.reviewed_names) -notcontains 'engineering-mcp') { throw 'SELFTEST_REVIEWED_NAME' }
    if ((Get-SanitizedInspectProjection 'not-json').coverage -ne 'UNKNOWN') { throw 'SELFTEST_UNKNOWN_SCHEMA' }
    if ((Get-SanitizedInspectProjection '{}').mcp.count -ne $null) { throw 'SELFTEST_MISSING_IS_EMPTY' }

    $caps = Get-Capabilities $true $true $true '--model --cwd --permission-mode --allow --deny --tools --disallowed-tools --max-turns --no-subagents --disable-web-search --output-format json streaming-json' ''
    if (-not $caps.supports_no_auto_update_invocation -or -not $caps.supports_agent_stdio -or -not $caps.supports_streaming_json) {
        throw 'SELFTEST_CAPABILITIES'
    }

    $args = @()
    foreach ($d in [Enum]::GetValues([EngineeringGrokPhase2.Diagnostic])) {
        $args += [EngineeringGrokPhase2.Native]::Arguments($d)
    }
    $expected = @(
        '--no-auto-update version',
        '--no-auto-update agent --help',
        '--no-auto-update agent stdio --help',
        '--no-auto-update inspect --help',
        '--no-auto-update inspect --json'
    )
    if ((ConvertTo-Json $args -Compress) -cne (ConvertTo-Json $expected -Compress)) {
        throw 'SELFTEST_FIXED_ARGV'
    }
    foreach ($arg in $args) {
        if ($arg -match '(^| )-p( |$)|--single|login|logout|authenticate|session/new|session/prompt') {
            throw 'SELFTEST_FORBIDDEN_COMMAND'
        }
    }

    if (-not (Test-IdentityMatch 'C:\X\grok.exe' ('a'*64) 'c:\x\GROK.EXE' ('A'*64))) {
        throw 'SELFTEST_IDENTITY_MATCH'
    }
    if (Test-IdentityMatch 'C:\X\grok.exe' ('a'*64) 'C:\X\grok.exe' ('b'*64)) {
        throw 'SELFTEST_ARTIFACT_CHANGE'
    }

    return [ordered]@{
        status='PASS'
        kind='GROK_PHASE2_OFFLINE_PROJECTION_AND_FIXED_COMMAND_TEST'
        grok_invocations=0
        model_calls=0
        auth_actions=0
        acp_sessions=0
    }
}

if ($SelfTest) {
    try {
        Initialize-NativeHelper
        Invoke-OfflineSelfTest | ConvertTo-Json -Depth 8
        exit 0
    } catch {
        [Console]::Out.WriteLine('{"status":"FAIL","kind":"GROK_PHASE2_OFFLINE_SELFTEST","details":"OMITTED"}')
        exit 1
    }
}

$report = [ordered]@{
    schema='grok-local-metadata/2'
    status='INCOMPLETE'
    artifact=[ordered]@{
        canonical_path_fingerprint=$null
        sha256=$null
        version='UNKNOWN'
    }
    capabilities=[ordered]@{
        supports_agent=$false
        supports_agent_stdio=$false
        supports_no_auto_update_invocation=$false
        supports_model_flag=$false
        supports_cwd_flag=$false
        supports_permission_mode=$false
        supports_allow=$false
        supports_deny=$false
        supports_tools=$false
        supports_disallowed_tools=$false
        supports_max_turns=$false
        supports_no_subagents=$false
        supports_disable_web_search=$false
        supports_output_json=$false
        supports_streaming_json=$false
    }
    inspect=[ordered]@{
        coverage='UNKNOWN'
        config_origins=[ordered]@{ count=$null; entries=@(); coverage='UNKNOWN' }
        mcp=[ordered]@{ count=$null; origin_categories=@(); reviewed_names=@(); coverage='UNKNOWN' }
        plugins=[ordered]@{ count=$null; origin_categories=@(); coverage='UNKNOWN' }
        hooks=[ordered]@{ count=$null; origin_categories=@(); coverage='UNKNOWN' }
        skills=[ordered]@{ count=$null; origin_categories=@(); origin_paths=@(); coverage='UNKNOWN' }
        instructions=[ordered]@{ count=$null; origin_categories=@(); origin_paths=@(); coverage='UNKNOWN' }
        permission_mode=$null
        model=$null
        compatibility=[ordered]@{ claude=$null; cursor=$null }
    }
    no_auto_update=[ordered]@{
        invocation_accepted=$false
        semantic_guarantee='UNPROVEN'
    }
    model_calls=0
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_REQUIRED' }
    if ([string]::IsNullOrWhiteSpace($Phase1CanonicalPath)) { throw 'PHASE1_PATH_REQUIRED' }
    if ($Phase1Sha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'PHASE1_SHA256_REQUIRED' }
    if ([IO.Path]::GetFileName($Phase1CanonicalPath) -cne 'grok.exe') { throw 'PHASE1_TARGET_NOT_GROK_EXE' }
    if (-not [IO.Path]::IsPathRooted($Phase1CanonicalPath)) { throw 'PHASE1_PATH_NOT_ABSOLUTE' }
    if (-not [IO.Directory]::Exists($FixedCwd)) { throw 'FIXED_CWD_UNAVAILABLE' }

    Initialize-NativeHelper
    $artifact = [EngineeringGrokPhase2.Native]::ReadArtifact($Phase1CanonicalPath)
    if (-not (Test-IdentityMatch $Phase1CanonicalPath $Phase1Sha256 $artifact.CanonicalPath $artifact.Sha256)) {
        throw 'ARTIFACT_CHANGED'
    }

    $canonical = $artifact.CanonicalPath
    $expectedHash = $artifact.Sha256
    $report.artifact.canonical_path_fingerprint = Get-PathFingerprint $canonical
    $report.artifact.sha256 = $expectedHash

    $captures = @{}
    foreach ($kind in @(
        [EngineeringGrokPhase2.Diagnostic]::Version,
        [EngineeringGrokPhase2.Diagnostic]::AgentHelp,
        [EngineeringGrokPhase2.Diagnostic]::StdioHelp,
        [EngineeringGrokPhase2.Diagnostic]::InspectHelp,
        [EngineeringGrokPhase2.Diagnostic]::Inspect
    )) {
        $again = [EngineeringGrokPhase2.Native]::ReadArtifact($canonical)
        if (-not (Test-IdentityMatch $canonical $expectedHash $again.CanonicalPath $again.Sha256)) {
            throw 'ARTIFACT_CHANGED'
        }

        $capture = [EngineeringGrokPhase2.Native]::Run($canonical,$expectedHash,$kind,$FixedCwd)
        $captures[[string]$kind] = $capture

        if ($capture.Status -ne 'EXITED') {
            if ($capture.Status -eq 'OUTPUT_LIMIT' -or $capture.Status -eq 'TIMEOUT' -or $capture.Status -eq 'PIPE_CLEANUP_UNPROVEN') {
                throw 'DIAGNOSTIC_BOUNDS_OR_CLEANUP_FAILED'
            }
        }

        $after = [EngineeringGrokPhase2.Native]::ReadArtifact($canonical)
        if (-not (Test-IdentityMatch $canonical $expectedHash $after.CanonicalPath $after.Sha256)) {
            throw 'ARTIFACT_CHANGED'
        }
    }

    $versionCapture = $captures['Version']
    if ($versionCapture.Status -eq 'EXITED' -and $versionCapture.ExitCode -eq 0) {
        $report.artifact.version = Get-VersionProjection $versionCapture.Out $versionCapture.Err
    }

    $agent = $captures['AgentHelp']
    $stdio = $captures['StdioHelp']
    $versionAccepted = (
        $versionCapture.Status -eq 'EXITED' -and
        $versionCapture.ExitCode -eq 0 -and
        (Get-StderrCategory $versionCapture.Err) -ne 'ARGUMENT_ERROR'
    )
    $agentAccepted = ($agent.Status -eq 'EXITED' -and $agent.ExitCode -eq 0)
    $stdioAccepted = ($stdio.Status -eq 'EXITED' -and $stdio.ExitCode -eq 0)

    $report.capabilities = Get-Capabilities $versionAccepted $agentAccepted $stdioAccepted $agent.Out $stdio.Out
    $report.no_auto_update.invocation_accepted = $versionAccepted
    # Invocation acceptance does not prove updater semantics.
    $report.no_auto_update.semantic_guarantee = 'UNPROVEN'

    $inspectCapture = $captures['Inspect']
    if ($inspectCapture.Status -eq 'EXITED' -and $inspectCapture.ExitCode -eq 0) {
        $report.inspect = Get-SanitizedInspectProjection $inspectCapture.Out
    }

    foreach ($capture in $captures.Values) {
        $capture.Out=''
        $capture.Err=''
    }
    $captures.Clear()
    $report.status='COMPLETE_METADATA_PROJECTION'
} catch {
    # Never emit raw ErrorRecord/exception text because upstream errors may
    # contain config paths, commands, tokens or other ambient data.
    if ($_.Exception.Message -ceq 'ARTIFACT_CHANGED') {
        $report.status='ARTIFACT_CHANGED'
    } else {
        $report.status='INCOMPLETE'
    }
}

$report | ConvertTo-Json -Depth 12
