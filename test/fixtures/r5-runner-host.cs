// Disposable R5 Runner-side fixture. The production execution-worker.exe is
// launched unchanged; only the surrounding Core/Runner and Harness are fake.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class R5RunnerHost {
  static string stage="START";
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static byte[] Exact(Stream source,int length) {
    if(length<0||length>4096)throw new InvalidDataException("R5_FIELD_BOUNDS");
    byte[] result=new byte[length];int offset=0;
    try {while(offset<length){int count=source.Read(result,offset,length-offset);if(count==0)throw new EndOfStreamException();offset+=count;}return result;}
    catch {Array.Clear(result,0,result.Length);throw;}
  }
  static byte[] Field(Stream source,int maximum) {
    byte[] header=Exact(source,4);
    try {int length=BitConverter.ToInt32(header,0);if(length<1||length>maximum)throw new InvalidDataException("R5_FIELD_BOUNDS");
      byte[] value=Exact(source,length);byte[] framed=new byte[4+length];
      Buffer.BlockCopy(header,0,framed,0,4);Buffer.BlockCopy(value,0,framed,4,length);
      Array.Clear(value,0,value.Length);return framed;
    } finally {Array.Clear(header,0,header.Length);}
  }
  static string Required(Dictionary<string,string> values,string name) {
    string value;if(!values.TryGetValue(name,out value)||String.IsNullOrEmpty(value))throw new InvalidDataException("R5_CONFIG_FIELD");
    return value;
  }
  static string Sha(string path) {using(var sha=SHA256.Create())using(var file=File.OpenRead(path))
    return BitConverter.ToString(sha.ComputeHash(file)).Replace("-","").ToLowerInvariant();}
  static string RandomSentinel() {
    byte[] bytes=new byte[32];using(var rng=RandomNumberGenerator.Create())rng.GetBytes(bytes);
    try{return Convert.ToBase64String(bytes);}finally{Array.Clear(bytes,0,bytes.Length);}
  }
  static bool InJob(IntPtr process,IntPtr job) {
    bool member;if(!IsProcessInJob(process,job,out member))throw new InvalidOperationException("R5_JOB_QUERY");return member;
  }
  static int Run(bool expectProfileFailure) {
    byte[] username=null,password=null,configuration=null,launchBytes=null;
    IntPtr job=IntPtr.Zero,workerHandle=IntPtr.Zero;
    Process helper=null;int workerPid=0;
    try {
      Stream input=Console.OpenStandardInput();
      username=Field(input,256);password=Field(input,1024);configuration=Field(input,4096);
      stage="FRAME_READ";
      if(input.ReadByte()!=-1)throw new InvalidDataException("R5_INPUT_TRAILING");
      var serializer=new JavaScriptSerializer();
      var config=serializer.Deserialize<Dictionary<string,string>>(
        Encoding.UTF8.GetString(configuration,4,configuration.Length-4));
      if(config.Count!=11)throw new InvalidDataException("R5_CONFIG_COUNT");
      stage="CONFIG_PARSED";
      string coreSid=Required(config,"coreSid"),workerSid=Required(config,"workerSid");
      if(WindowsIdentity.GetCurrent().User.Value!=coreSid)throw new InvalidOperationException("R5_CORE_SID");
      string helperPath=Required(config,"helperPath"),workerExecutable=Required(config,"workerExecutable");
      string cwd=Required(config,"cwd");
      if(!Path.IsPathRooted(helperPath)||!Path.IsPathRooted(workerExecutable)||!Path.IsPathRooted(cwd))
        throw new InvalidDataException("R5_ABSOLUTE_PATH");
      Environment.SetEnvironmentVariable("ENGINEERING_R5_CORE_SENTINEL",RandomSentinel(),EnvironmentVariableTarget.Process);
      job=CreateJobObject(IntPtr.Zero,null);
      if(job==IntPtr.Zero||!AssignProcessToJobObject(job,GetCurrentProcess())||!InJob(GetCurrentProcess(),job))
        throw new InvalidOperationException("R5_RUNNER_JOB");
      stage="RUNNER_JOB";
      var launch=new Dictionary<string,object> {
        {"schema","engineering-restricted-worker-launch/1"},
        {"executable",workerExecutable},{"executableSha256",Sha(workerExecutable)},
        {"args",new string[]{"--worker"}},{"verbatimArguments",false},{"cwd",cwd},
        {"workerSid",workerSid},{"coreSid",coreSid},
        {"keeperSid",Required(config,"keeperSid")},{"operatorSid",Required(config,"operatorSid")},
        {"runnerPid",Process.GetCurrentProcess().Id},{"jobHandle",job.ToInt64().ToString()}
      };
      launchBytes=Encoding.UTF8.GetBytes(serializer.Serialize(launch));
      stage="LAUNCH_SERIALIZED";
      var start=new ProcessStartInfo {FileName=helperPath,Arguments="--launch",WorkingDirectory=cwd,
        UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,
        RedirectStandardOutput=true,RedirectStandardError=true};
      foreach(string name in new string[]{"ENGINEERING_R5E_READY_EVENT","ENGINEERING_R5E_RELEASE_EVENT"}) {
        string value=Environment.GetEnvironmentVariable(name);
        if(value!=null)start.EnvironmentVariables[name]=value;
      }
      helper=Process.Start(start);if(helper==null||!InJob(helper.Handle,job))throw new InvalidOperationException("R5_HELPER_JOB");
      stage="HELPER_STARTED";
      var stderr=Task.Run(()=>helper.StandardError.ReadToEnd());
      Stream target=helper.StandardInput.BaseStream;
      target.Write(username,0,username.Length);target.Write(password,0,password.Length);
      Array.Clear(password,0,password.Length);password=null;
      byte[] length=BitConverter.GetBytes(launchBytes.Length);
      target.Write(length,0,length.Length);target.Write(launchBytes,0,launchBytes.Length);target.Flush();
      stage="FRAME_SENT";
      Array.Clear(length,0,length.Length);
      if(expectProfileFailure) {
        helper.StandardInput.Close();
        string output=helper.StandardOutput.ReadToEnd();
        if(!helper.WaitForExit(30000)||!stderr.Wait(5000)||helper.ExitCode!=90||
          output.Length!=0||!stderr.Result.StartsWith("WORKER_LAUNCH_REFUSED:",StringComparison.Ordinal))
          throw new InvalidOperationException("R5_PROFILE_FAILURE_NOT_CLOSED");
        Console.WriteLine("R5_PROFILE_LAUNCH_REFUSED "+serializer.Serialize(new {
          runner_pid=Process.GetCurrentProcess().Id,helper_pid=helper.Id,
          helper_exit=helper.ExitCode,worker_ready=false,
          refusal_type=stderr.Result.Trim()
        }));
        return 0;
      }
      var ready=Task.Run(()=>helper.StandardOutput.ReadLine());
      if(!ready.Wait(30000)||ready.Result==null||!ready.Result.StartsWith("R5_READY ",StringComparison.Ordinal)
        ||!Int32.TryParse(ready.Result.Substring(9),out workerPid)) {
        string helperError=stderr.Wait(5000)?stderr.Result.Trim():"STDERR_PENDING";
        if(helperError.Length>256)helperError=helperError.Substring(0,256);
        throw new InvalidOperationException("R5_WORKER_READY:"+helperError);
      }
      stage="WORKER_READY";
      workerHandle=OpenProcess(0x1000,false,workerPid);
      if(workerHandle==IntPtr.Zero||!InJob(workerHandle,job))throw new InvalidOperationException("R5_WORKER_JOB");
      stage="WORKER_JOB";
      string protocol=serializer.Serialize(new Dictionary<string,string> {
        {"protocol","R5_TASK_PROTOCOL_FIXTURE"},
        {"worker_env_sha256",Required(config,"workerEnvSha256")},
        {"worker_hkcu_sha256",Required(config,"workerHkcuSha256")},
        {"core_hkcu_sha256",Required(config,"coreHkcuSha256")},
        {"provider_sha256",Required(config,"providerSha256")}
      });
      byte[] task=Encoding.UTF8.GetBytes(protocol);
      target.Write(task,0,task.Length);target.Flush();helper.StandardInput.Close();
      stage="PROTOCOL_SENT";
      Array.Clear(task,0,task.Length);
      var resultLine=Task.Run(()=>helper.StandardOutput.ReadLine());
      if(!resultLine.Wait(30000)||resultLine.Result==null||
        !resultLine.Result.StartsWith("R5_RESULT ",StringComparison.Ordinal))
        throw new InvalidOperationException("R5_RESULT_MISSING");
      stage="RESULT_RECEIVED";
      if(!helper.WaitForExit(30000)||helper.ExitCode!=0||!stderr.Wait(5000))
        throw new InvalidOperationException("R5_HELPER_EXIT");
      var workerResult=serializer.DeserializeObject(resultLine.Result.Substring(10));
      Console.WriteLine("R5_HOST_RESULT "+serializer.Serialize(new {
        runner_pid=Process.GetCurrentProcess().Id,runner_sid=coreSid,
        helper_pid=helper.Id,worker_pid=workerPid,
        runner_same_job=true,helper_same_job=true,worker_same_job=true,
        helper_exit=helper.ExitCode,protocol_stderr_ok=stderr.Result.Trim()=="R5_STDERR_DRAIN_OK",
        worker=workerResult
      }));
      return 0;
    } finally {
      if(username!=null)Array.Clear(username,0,username.Length);
      if(password!=null)Array.Clear(password,0,password.Length);
      if(configuration!=null)Array.Clear(configuration,0,configuration.Length);
      if(launchBytes!=null)Array.Clear(launchBytes,0,launchBytes.Length);
      if(workerHandle!=IntPtr.Zero)CloseHandle(workerHandle);
      if(helper!=null) {
        try {if(!helper.HasExited){helper.Kill();helper.WaitForExit(10000);}}catch{}
        helper.Dispose();
      }
      if(job!=IntPtr.Zero)CloseHandle(job);
    }
  }
  static int Main(string[] args) {
    try {if(args.Length>1||(args.Length==1&&args[0]!="--expect-profile-failure"))
      throw new InvalidDataException("R5_ARGS");return Run(args.Length==1);}
    catch(Exception error){Console.Error.WriteLine("R5_HOST_REFUSED:"+error.GetType().Name+":"+stage+
      ":"+(error.Message.StartsWith("R5_WORKER_READY:",StringComparison.Ordinal)?error.Message:"FIXTURE_FAILURE"));return 86;}
  }
}
