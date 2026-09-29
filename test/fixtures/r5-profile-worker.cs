// Disposable R5 profile fixture. It never reads real provider credentials.
using System;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
using Microsoft.Win32;

internal static class R5ProfileWorker {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int length,out int returned);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Hex(byte[] bytes) {return BitConverter.ToString(bytes).Replace("-","");}
  static string Hash(byte[] bytes) {using(var sha=SHA256.Create())return Hex(sha.ComputeHash(bytes));}
  static string HashText(string text) {return Hash(Encoding.UTF8.GetBytes(text));}
  static void RequireDisposable(string expected) {
    using(var identity=WindowsIdentity.GetCurrent()) {
      string name=identity.Name;
      int separator=name.LastIndexOf('\\');
      if(separator<0||!name.Substring(separator+1).Equals(expected,StringComparison.Ordinal)||
        new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
        throw new InvalidOperationException("R5_DISPOSABLE_IDENTITY_REQUIRED");
    }
  }
  static string RandomMarker() {
    byte[] bytes=new byte[32];using(var rng=RandomNumberGenerator.Create())rng.GetBytes(bytes);
    try{return Convert.ToBase64String(bytes);}finally{Array.Clear(bytes,0,bytes.Length);}
  }
  static string ProfileMarker() {
    using(var key=Registry.CurrentUser.OpenSubKey(@"Software\EngineeringMCP-R5\Proof"))
      return key==null?null:key.GetValue("Marker") as string;
  }
  static object Token() {
    IntPtr token=IntPtr.Zero,buffer=IntPtr.Zero,elevation=IntPtr.Zero;
    try {
      if(!OpenProcessToken(GetCurrentProcess(),8,out token))throw new InvalidOperationException("TOKEN_OPEN");
      int size;GetTokenInformation(token,25,IntPtr.Zero,0,out size);
      if(size<IntPtr.Size+4||size>65536)throw new InvalidOperationException("TOKEN_INTEGRITY_SIZE");
      buffer=Marshal.AllocHGlobal(size);
      if(!GetTokenInformation(token,25,buffer,size,out size))throw new InvalidOperationException("TOKEN_INTEGRITY");
      IntPtr sid=Marshal.ReadIntPtr(buffer);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      if(count==0)throw new InvalidOperationException("TOKEN_INTEGRITY_COUNT");
      int integrity=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
      elevation=Marshal.AllocHGlobal(4);
      if(!GetTokenInformation(token,20,elevation,4,out size))throw new InvalidOperationException("TOKEN_ELEVATION");
      bool inJob;if(!IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out inJob))throw new InvalidOperationException("JOB_QUERY");
      using(var identity=WindowsIdentity.GetCurrent()) {
        return new {pid=System.Diagnostics.Process.GetCurrentProcess().Id,
          sid=identity.User.Value,integrity=integrity,elevated=Marshal.ReadInt32(elevation)!=0,
          admin_member=new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator),in_job=inJob};
      }
    } finally {
      if(elevation!=IntPtr.Zero)Marshal.FreeHGlobal(elevation);
      if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);
      if(token!=IntPtr.Zero)CloseHandle(token);
    }
  }
  static int Setup(string role) {
    RequireDisposable(role=="core"?"CoreR5Test":"WorkerR5Test");
    string marker=RandomMarker();
    using(var key=Registry.CurrentUser.CreateSubKey(@"Software\EngineeringMCP-R5\Proof"))key.SetValue("Marker",marker);
    if(role=="worker") {
      string environmentMarker=RandomMarker();
      using(var key=Registry.CurrentUser.CreateSubKey("Environment"))
        key.SetValue("ENGINEERING_R5_WORKER_MARKER",environmentMarker);
      string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
      string folder=Path.Combine(local,"EngineeringMCP-R5");Directory.CreateDirectory(folder);
      string path=Path.Combine(folder,"provider-marker.bin");
      byte[] provider=new byte[64];using(var rng=RandomNumberGenerator.Create())rng.GetBytes(provider);
      try {File.WriteAllBytes(path,provider);
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {
          role=role,sid=WindowsIdentity.GetCurrent().User.Value,
          profile=Environment.GetEnvironmentVariable("USERPROFILE"),provider_path=path,
          hkcu_sha256=HashText(marker),env_sha256=HashText(environmentMarker),provider_sha256=Hash(provider)
        }));
      } finally {Array.Clear(provider,0,provider.Length);}
    } else Console.WriteLine(new JavaScriptSerializer().Serialize(new {
      role=role,sid=WindowsIdentity.GetCurrent().User.Value,hkcu_sha256=HashText(marker)
    }));
    return 0;
  }
  static int ReadProvider(string path) {
    using(var identity=WindowsIdentity.GetCurrent()) {
      string name=identity.Name;
      int separator=name.LastIndexOf('\\');
      if(separator<0||(name.Substring(separator+1)!="CoreR5Test"&&
        name.Substring(separator+1)!="KeeperR5Test")||
        new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
        throw new InvalidOperationException("R5_DISPOSABLE_IDENTITY_REQUIRED");
    }
    string sid=WindowsIdentity.GetCurrent().User.Value;
    try {using(var stream=File.OpenRead(path))stream.ReadByte();
      Console.WriteLine("R5_PROVIDER_READ_ALLOWED sid="+sid);return 3;}
    catch(UnauthorizedAccessException){Console.WriteLine("R5_PROVIDER_ACCESS_DENIED sid="+sid);return 0;}
  }
  static int Worker() {
    RequireDisposable("WorkerR5Test");
    var serializer=new JavaScriptSerializer();
    var identity=Token();
    Console.WriteLine("R5_READY "+System.Diagnostics.Process.GetCurrentProcess().Id);Console.Out.Flush();
    string raw=Console.In.ReadToEnd();
    if(raw.Length<1||raw.Length>4096)throw new InvalidDataException("R5_PROTOCOL_BOUNDS");
    var request=serializer.Deserialize<System.Collections.Generic.Dictionary<string,string>>(raw);
    if(request.Count!=5||request["protocol"]!="R5_TASK_PROTOCOL_FIXTURE")throw new InvalidDataException("R5_PROTOCOL_CONTRACT");
    string environmentMarker=Environment.GetEnvironmentVariable("ENGINEERING_R5_WORKER_MARKER");
    string hkcu=ProfileMarker();
    string local=Environment.GetEnvironmentVariable("LOCALAPPDATA");
    string provider=local==null?null:Path.Combine(local,"EngineeringMCP-R5","provider-marker.bin");
    bool exists=provider!=null&&File.Exists(provider);
    string providerHash=exists?Hash(File.ReadAllBytes(provider)):null;
    Console.WriteLine("R5_RESULT "+serializer.Serialize(new {
      identity=identity,
      userprofile=Environment.GetEnvironmentVariable("USERPROFILE"),
      localappdata=local,appdata=Environment.GetEnvironmentVariable("APPDATA"),
      worker_env_marker_present=environmentMarker!=null&&HashText(environmentMarker)==request["worker_env_sha256"],
      core_sentinel_present=Environment.GetEnvironmentVariable("ENGINEERING_R5_CORE_SENTINEL")!=null,
      worker_hkcu_marker_present=hkcu!=null&&HashText(hkcu)==request["worker_hkcu_sha256"],
      core_hkcu_marker_seen=hkcu!=null&&HashText(hkcu)==request["core_hkcu_sha256"],
      provider_marker_exists=exists,provider_marker_length=exists?new FileInfo(provider).Length:0,
      provider_marker_sha256=providerHash,
      provider_marker_matches=providerHash==request["provider_sha256"],
      protocol_stdin_ok=true
    }));Console.Out.Flush();
    Console.Error.WriteLine("R5_STDERR_DRAIN_OK");Console.Error.Flush();
    return 0;
  }
  static int Main(string[] args) {
    try {
      if(args.Length==2&&args[0]=="--setup"&&(args[1]=="core"||args[1]=="worker"))return Setup(args[1]);
      if(args.Length==2&&args[0]=="--read-provider")return ReadProvider(args[1]);
      if(args.Length==1&&args[0]=="--worker")return Worker();
      throw new InvalidDataException("R5_ARGS");
    } catch(Exception error){Console.Error.WriteLine("R5_FIXTURE_REFUSED:"+error.GetType().Name);return 86;}
  }
}
