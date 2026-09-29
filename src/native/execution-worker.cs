// Development-only Worker transition. No credential argv, environment or file.
// Only the three explicitly created task-protocol pipes are inheritable when
// CreateProcessWithLogonW runs. The Job and Runner handles are non-inheritable.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
#if TEST_FAULT
using System.Threading;
#endif
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ExecutionWorker {
  const string Build = "engineering-execution-worker/1";
  const uint Suspended = 4, NoWindow = 0x08000000, LogonWithProfile = 1;
  const int InteractiveLogon=2, DefaultProvider=0;
  const uint TokenQuery = 8, ProcessQuery = 0x1000, ProcessDuplicate = 0x40;
  const uint JobAssignQuery = 5, Inherit = 1;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved, desktop, title;
    public int x,y,xsize,ysize,xchars,ychars,fill,flags;
    public short show,reserved2; public IntPtr reservedPointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr process,thread; public int pid,tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES {
    public IntPtr sid; public uint attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_GROUPS_ONE {
    public uint count; public SID_AND_ATTRIBUTES first;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr attributes,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle,out uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int which,IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CancelIoEx(IntPtr handle,IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr destinationProcess,out IntPtr destination,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size,out int returned);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessWithLogonW(string username,string domain,IntPtr password,uint flags,string executable,StringBuilder command,uint creationFlags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("advapi32.dll",EntryPoint="LogonUserW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LogonUser(string user,string domain,IntPtr password,int logonType,int provider,out IntPtr token);
  [DllImport("userenv.dll",EntryPoint="GetUserProfileDirectoryW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserProfileDirectory(IntPtr token,StringBuilder path,ref uint size);

  static void Check(bool ok,string code) { if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),code); }
  static void Close(ref IntPtr h) { if(h!=IntPtr.Zero){CloseHandle(h);h=IntPtr.Zero;} }
  static FileStream OpenOwnedStandardInput(out SafeFileHandle owned) {
    IntPtr raw=GetStdHandle(-10);owned=null;
    if(raw==IntPtr.Zero||raw==new IntPtr(-1))throw new InvalidOperationException("SECRET_INPUT_HANDLE");
    owned=new SafeFileHandle(raw,true);
    try {
      Check(SetHandleInformation(raw,Inherit,0),"SECRET_INPUT_INHERITANCE");
      Check(SetStdHandle(-10,IntPtr.Zero),"SECRET_INPUT_DETACH");
      return new FileStream(owned,FileAccess.Read,1,false);
    } catch {owned.Dispose();throw;}
  }
  static void CloseProtocolInput(FileStream input,SafeFileHandle inputHandle,
    FileStream writer,SafeFileHandle writerHandle,Task pump) {
    bool inputPinned=false,writerPinned=false;
    IntPtr rawInput=IntPtr.Zero,rawWriter=IntPtr.Zero;
    try {
      if(inputHandle!=null&&!inputHandle.IsClosed) {
        try {inputHandle.DangerousAddRef(ref inputPinned);rawInput=inputHandle.DangerousGetHandle();}
        catch(ObjectDisposedException){/* completed pump closed this exact handle */}
      }
      if(writerHandle!=null&&!writerHandle.IsClosed) {
        try {writerHandle.DangerousAddRef(ref writerPinned);rawWriter=writerHandle.DangerousGetHandle();}
        catch(ObjectDisposedException){/* completed pump closed this exact handle */}
      }
      // Mark both streams closed before cancellation so no new read/write can
      // start. Extra SafeHandle references prevent raw handle reuse while a
      // racing already-started operation is canceled by the bounded loop.
      if(inputHandle!=null)inputHandle.Dispose();
      if(writerHandle!=null)writerHandle.Dispose();
      if(input!=null)input.Dispose();
      // Both streams are constructed with bufferSize=1, so no managed pending
      // write buffer is flushed here. SafeHandle closure completes after the
      // pinned references and canceled I/O references have been released.
      if(writer!=null)writer.Dispose();
      DateTime deadline=DateTime.UtcNow.AddSeconds(1);
      do {
        if(rawInput!=IntPtr.Zero)CancelIoEx(rawInput,IntPtr.Zero);
        if(rawWriter!=IntPtr.Zero)CancelIoEx(rawWriter,IntPtr.Zero);
        if(pump==null||pump.IsCompleted)return;
        try {if(pump.Wait(25))return;}catch(AggregateException){return;}
      } while(DateTime.UtcNow<deadline);
      throw new TimeoutException("WORKER_INPUT_DRAIN");
    } finally {
      if(writerPinned)writerHandle.DangerousRelease();
      if(inputPinned)inputHandle.DangerousRelease();
    }
  }
  static void ValidateLogonCommand(StringBuilder command) {
    if(command.Length>1024)throw new InvalidOperationException("LOGON_COMMAND_LENGTH");
  }
  static byte[] ReadExact(Stream input,int length) {
    byte[] result=new byte[length];
    try { int offset=0; while(offset<length){int n=input.Read(result,offset,length-offset);if(n==0)throw new EndOfStreamException();offset+=n;}return result; }
    catch { Array.Clear(result,0,result.Length);throw; }
  }
  static byte[] Field(Stream input,int maximum) {
    byte[] header=ReadExact(input,4);
    try {int n=BitConverter.ToInt32(header,0);if(n<1||n>maximum)throw new InvalidDataException();return ReadExact(input,n);}
    finally {Array.Clear(header,0,header.Length);}
  }
  static string Text(Dictionary<string,object> value,string key) {
    object raw; if(!value.TryGetValue(key,out raw)||!(raw is string)||((string)raw).Length==0||((string)raw).IndexOf('\0')>=0)throw new InvalidDataException();return (string)raw;
  }
  static string Quote(string s) {
    var b=new StringBuilder("\"");int n=0;
    foreach(char c in s){if(c=='\\'){n++;continue;}b.Append('\\',c=='"'?n*2+1:n).Append(c);n=0;}
    return b.Append('\\',n*2).Append('"').ToString();
  }
  static void RejectAdministratorGroups(IntPtr buffer,int size) {
    int first=Marshal.OffsetOf(typeof(TOKEN_GROUPS_ONE),"first").ToInt32();
    int stride=Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    if(size<first)throw new InvalidOperationException("TOKEN_GROUPS_SIZE");
    uint count=unchecked((uint)Marshal.ReadInt32(buffer));
    if(count>(uint)((size-first)/stride))throw new InvalidOperationException("TOKEN_GROUPS_COUNT");
    for(int i=0;i<(int)count;i++) {
      IntPtr sid=Marshal.ReadIntPtr(buffer,first+i*stride);
      if(sid==IntPtr.Zero)throw new InvalidOperationException("TOKEN_GROUP_SID");
      // Attributes are deliberately not filtered: deny-only and disabled
      // Administrators membership also disqualify a Worker token.
      if(new SecurityIdentifier(sid).Value=="S-1-5-32-544")
        throw new InvalidOperationException("WORKER_ADMIN_GROUP");
    }
  }
  static string TokenSid(IntPtr token,bool restricted) {
      using(var identity=new WindowsIdentity(token)) {
        if(identity.User==null)throw new InvalidOperationException("TOKEN_USER");
        if(restricted) {
          // WindowsIdentity.Groups omits deny-only membership on .NET Framework.
          // Inspect the unfiltered native TokenGroups instead.
          int size; GetTokenInformation(token,2,IntPtr.Zero,0,out size);
          if(size<4||size>65536)throw new InvalidOperationException("TOKEN_GROUPS_SIZE");
          IntPtr groups=Marshal.AllocHGlobal(size);
          try {
            int returned;Check(GetTokenInformation(token,2,groups,size,out returned),"TOKEN_GROUPS");
            if(returned<0||returned>size)throw new InvalidOperationException("TOKEN_GROUPS_SIZE");
            RejectAdministratorGroups(groups,returned);
          } finally {Marshal.FreeHGlobal(groups);}
          GetTokenInformation(token,25,IntPtr.Zero,0,out size);
          if(size< IntPtr.Size+4 || size>65536)throw new InvalidOperationException("TOKEN_INTEGRITY_SIZE");
          IntPtr buffer=Marshal.AllocHGlobal(size);
          try {
            Check(GetTokenInformation(token,25,buffer,size,out size),"TOKEN_INTEGRITY");
            IntPtr sid=Marshal.ReadIntPtr(buffer);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            if(count==0||Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)))!=8192)
              throw new InvalidOperationException("WORKER_INTEGRITY");
          } finally {Marshal.FreeHGlobal(buffer);}
          IntPtr elevation=Marshal.AllocHGlobal(4);
          try {Check(GetTokenInformation(token,20,elevation,4,out size),"TOKEN_ELEVATION");if(Marshal.ReadInt32(elevation)!=0)throw new InvalidOperationException("WORKER_ELEVATED");}
          finally {Marshal.FreeHGlobal(elevation);}
        }
        return identity.User.Value;
      }
  }
  static string Sid(IntPtr process,bool restricted) {
    IntPtr token=IntPtr.Zero;
    try {
      Check(OpenProcessToken(process,TokenQuery | 2,out token),"TOKEN_QUERY");
      return TokenSid(token,restricted);
    } finally {Close(ref token);}
  }
  static string ProfileRoot(IntPtr token,string refusal) {
    uint length=4096;var path=new StringBuilder((int)length);
    if(!GetUserProfileDirectory(token,path,ref length)) {
#if TEST_FAULT
      profileWin32Error=Marshal.GetLastWin32Error();
#endif
      throw new InvalidOperationException(refusal);
    }
    string raw=path.ToString();
    if(length<2||length>(uint)path.Capacity||raw.Length<3||raw.IndexOf('\0')>=0||
      !Char.IsLetter(raw[0])||raw[1]!=':'||(raw[2]!='\\'&&raw[2]!='/'))
      throw new InvalidOperationException(refusal);
    try {
      string full=Path.GetFullPath(raw);
      if(full.Length>4096||!Path.IsPathRooted(full)||String.IsNullOrEmpty(Path.GetPathRoot(full)))
        throw new InvalidOperationException(refusal);
      return full;
    } catch(ArgumentException) {throw new InvalidOperationException(refusal);}
      catch(NotSupportedException) {throw new InvalidOperationException(refusal);}
      catch(PathTooLongException) {throw new InvalidOperationException(refusal);}
  }
  static void RequireNonInheritable(IntPtr handle,string refusal) {
    uint flags;Check(GetHandleInformation(handle,out flags),refusal);
    if((flags&Inherit)!=0)throw new InvalidOperationException(refusal);
  }
#if TEST_FAULT
  // Compiled only in the isolated fault-test binary, never in release staging.
  static string profilePhase="NOT_STARTED";
  static int profileWin32Error=0;
  static int profileChildPid=0;
  static string profileExpectedRoot="NOT_OBSERVED",profileActualRoot="NOT_OBSERVED";
  static void ProfileLaunchFaultBarrier() {
    string ready=Environment.GetEnvironmentVariable("ENGINEERING_R5E_READY_EVENT");
    string release=Environment.GetEnvironmentVariable("ENGINEERING_R5E_RELEASE_EVENT");
    if(ready==null&&release==null)return;
    if(String.IsNullOrEmpty(ready)||String.IsNullOrEmpty(release))
      throw new InvalidOperationException("PROFILE_TEST_BARRIER_CONFIG");
    using(var readyEvent=EventWaitHandle.OpenExisting(ready))
    using(var releaseEvent=EventWaitHandle.OpenExisting(release)) {
      readyEvent.Set();
      if(!releaseEvent.WaitOne(TimeSpan.FromSeconds(20)))
        throw new TimeoutException("PROFILE_TEST_BARRIER_TIMEOUT");
    }
  }
#endif
  static FileStream Own(ref IntPtr handle,FileAccess access) {
    var owned=new SafeFileHandle(handle,true);handle=IntPtr.Zero;
    try {return new FileStream(owned,access);}
    catch {owned.Dispose();throw;}
  }
  static void ValidateWorkerRoles(string actual,string expected,string core,string keeper,string operatorSid) {
    if(actual!=expected||actual==core||actual==keeper||actual==operatorSid||actual=="S-1-5-18")
      throw new InvalidOperationException("WORKER_SID");
  }
  static void CopyBounded(Stream source,Stream target) {
    byte[] buffer=new byte[16384];
    try {int n;while((n=source.Read(buffer,0,buffer.Length))!=0){target.Write(buffer,0,n);target.Flush();}}
    finally {Array.Clear(buffer,0,buffer.Length);}
  }
  static void TerminateAndWait(IntPtr process) {
    if(process==IntPtr.Zero)return;
    if(WaitForSingleObject(process,0)==0)return;
    Check(TerminateProcess(process,82),"UNCOMMITTED_CHILD_TERMINATE");
    if(WaitForSingleObject(process,10000)!=0)throw new InvalidOperationException("UNCOMMITTED_CHILD_WAIT");
  }
  static int Run() {
    SafeFileHandle inputHandle;
    FileStream input=OpenOwnedStandardInput(out inputHandle);
    byte[] username=null,password=null,configuration=null;GCHandle pin=new GCHandle();
    FileStream writer=null,reader=null,error=null;SafeFileHandle writerHandle=null;
    Task writeTask=null;
    IntPtr runner=IntPtr.Zero,job=IntPtr.Zero;
    IntPtr profileToken=IntPtr.Zero,childToken=IntPtr.Zero;
    IntPtr childRead=IntPtr.Zero,parentWrite=IntPtr.Zero,parentRead=IntPtr.Zero,childWrite=IntPtr.Zero;
    IntPtr errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero;
    PROCESS_INFORMATION child=new PROCESS_INFORMATION();bool finished=false;
    try {
      username=Field(input,256);password=Field(input,1024);configuration=Field(input,65536);
      if(password.Length<4||(password.Length&1)!=0||password[password.Length-1]!=0||password[password.Length-2]!=0)throw new InvalidDataException();
      string user=new UTF8Encoding(false,true).GetString(username);
      if(user.Length==0||user.IndexOfAny(new char[]{'\\','/','@','\0'})>=0)throw new InvalidDataException();
      var config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(configuration));
      if(config.Count!=12||Text(config,"schema")!="engineering-restricted-worker-launch/1")throw new InvalidDataException();
      string executable=Text(config,"executable"),cwd=Text(config,"cwd"),expected=Text(config,"workerSid");
      string core=Text(config,"coreSid"),keeper=Text(config,"keeperSid"),operatorSid=Text(config,"operatorSid");
      if(expected==core||expected==keeper||expected==operatorSid||expected=="S-1-5-18"||Sid(GetCurrentProcess(),false)!=core)
        throw new InvalidOperationException("ROLE_BINDING");
      new SecurityIdentifier(expected);new SecurityIdentifier(core);new SecurityIdentifier(keeper);new SecurityIdentifier(operatorSid);
      if(!Path.IsPathRooted(executable)||!executable.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)||!Path.IsPathRooted(cwd)||!Directory.Exists(cwd))throw new InvalidDataException();
      var arguments=config["args"] as System.Collections.IList;
      if(arguments==null||arguments.Count>256)throw new InvalidDataException();
      if(!(config["verbatimArguments"] is bool))throw new InvalidDataException();
      bool verbatim=(bool)config["verbatimArguments"];
      if(verbatim&&(!String.Equals(executable,@"C:\Windows\System32\cmd.exe",StringComparison.OrdinalIgnoreCase)
        ||arguments.Count!=5||!Object.Equals(arguments[0],"/d")||!Object.Equals(arguments[1],"/s")
        ||!Object.Equals(arguments[2],"/v:off")||!Object.Equals(arguments[3],"/c")))throw new InvalidDataException();
      var command=new StringBuilder(Quote(executable));
      foreach(object raw in arguments){string arg=raw as string;if(arg==null||arg.IndexOf('\0')>=0)throw new InvalidDataException();command.Append(' ').Append(verbatim?arg:Quote(arg));}
      ValidateLogonCommand(command);
      long handleValue;if(!Int64.TryParse(Text(config,"jobHandle"),out handleValue)||handleValue<=0)throw new InvalidDataException();
      int runnerPid=Convert.ToInt32(config["runnerPid"]);if(runnerPid<=0)throw new InvalidDataException();
      runner=OpenProcess(ProcessQuery|ProcessDuplicate,false,runnerPid);Check(runner!=IntPtr.Zero,"RUNNER_OPEN");
      if(Sid(runner,false)!=core)throw new InvalidOperationException("RUNNER_IDENTITY");
      Check(DuplicateHandle(runner,new IntPtr(handleValue),GetCurrentProcess(),out job,JobAssignQuery,false,0),"JOB_DUPLICATE");
      bool member;Check(IsProcessInJob(runner,job,out member)&&member,"RUNNER_JOB");
      Check(IsProcessInJob(GetCurrentProcess(),job,out member)&&member,"HELPER_JOB");
      // Strip inheritance from the launch/secret channel and response channels.
      foreach(int which in new int[]{-11,-12})Check(SetHandleInformation(GetStdHandle(which),Inherit,0),"CLEAR_STANDARD_INHERITANCE");
      Check(CreatePipe(out childRead,out parentWrite,IntPtr.Zero,0),"INPUT_PIPE");
      Check(CreatePipe(out parentRead,out childWrite,IntPtr.Zero,0),"OUTPUT_PIPE");
      Check(CreatePipe(out errorRead,out errorWrite,IntPtr.Zero,0),"ERROR_PIPE");
      foreach(IntPtr h in new IntPtr[]{childRead,childWrite,errorWrite})Check(SetHandleInformation(h,Inherit,Inherit),"TASK_PIPE_INHERITANCE");
      var startup=new STARTUPINFO{cb=Marshal.SizeOf(typeof(STARTUPINFO)),flags=0x100,input=childRead,output=childWrite,error=errorWrite};
      pin=GCHandle.Alloc(password,GCHandleType.Pinned);
      // Hold the exact executable open without write/delete sharing through spawn.
      using(var artifact=new FileStream(executable,FileMode.Open,FileAccess.Read,FileShare.Read)) {
        using(var hash=SHA256.Create())if(BitConverter.ToString(hash.ComputeHash(artifact)).Replace("-","").ToLowerInvariant()!=Text(config,"executableSha256"))throw new InvalidOperationException("ARTIFACT_MISMATCH");
        try {
          Check(LogonUser(user,".",pin.AddrOfPinnedObject(),InteractiveLogon,DefaultProvider,out profileToken),"WORKER_LOGON");
          RequireNonInheritable(profileToken,"WORKER_TOKEN_INHERITANCE");
          ValidateWorkerRoles(TokenSid(profileToken,true),expected,core,keeper,operatorSid);
#if TEST_FAULT
          profilePhase="USERENV_PRE";
#endif
          string expectedProfileRoot=ProfileRoot(profileToken,"PROFILE_NOT_PROVISIONED");
#if TEST_FAULT
          profileExpectedRoot=expectedProfileRoot;
          profilePhase="BARRIER";
          ProfileLaunchFaultBarrier();
#endif
          // Userenv preflight checks registration. The suspended child's own
          // token supplies the post-create binding; neither check locks ProfileList.
          foreach(IntPtr excluded in new IntPtr[]{runner,job,inputHandle.DangerousGetHandle(),
            parentWrite,parentRead,errorRead,artifact.SafeFileHandle.DangerousGetHandle()})
            RequireNonInheritable(excluded,"WORKER_UNRELATED_HANDLE_INHERITANCE");
#if TEST_FAULT
          profilePhase="WORKER_CREATE";
#endif
          Check(CreateProcessWithLogonW(user,".",pin.AddrOfPinnedObject(),LogonWithProfile,executable,command,Suspended|NoWindow,IntPtr.Zero,cwd,ref startup,out child),"WORKER_CREATE");
#if TEST_FAULT
          profileChildPid=child.pid;
          profilePhase="CHILD_TOKEN";
#endif
          Check(OpenProcessToken(child.process,TokenQuery,out childToken),"CHILD_TOKEN_QUERY");
          ValidateWorkerRoles(TokenSid(childToken,true),expected,core,keeper,operatorSid);
#if TEST_FAULT
          profilePhase="USERENV_POST";
#endif
          string actualProfileRoot=ProfileRoot(childToken,"PROFILE_BINDING_REFUSED");
#if TEST_FAULT
          profileActualRoot=actualProfileRoot;
#endif
          if(!String.Equals(actualProfileRoot,expectedProfileRoot,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("PROFILE_BINDING_REFUSED");
        }
        finally {Array.Clear(password,0,password.Length);pin.Free();password=null;}
      }
      Close(ref childToken);Close(ref profileToken);
      Check(IsProcessInJob(child.process,job,out member),"WORKER_INITIAL_JOB");
      if(!member)Check(AssignProcessToJobObject(job,child.process),"WORKER_JOB_ASSIGN");
      Check(IsProcessInJob(child.process,job,out member)&&member,"WORKER_JOB_MEMBERSHIP");
      Close(ref childRead);Close(ref childWrite);Close(ref errorWrite);
      if(ResumeThread(child.thread)==uint.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error(),"WORKER_RESUME");
      writerHandle=new SafeFileHandle(parentWrite,true);parentWrite=IntPtr.Zero;
      writer=new FileStream(writerHandle,FileAccess.Write,1,false);
      reader=Own(ref parentRead,FileAccess.Read);error=Own(ref errorRead,FileAccess.Read);
      {
        writeTask=Task.Run(()=>{try{CopyBounded(input,writer);}finally{writer.Close();}});
        var outputTask=Task.Run(()=>CopyBounded(reader,Console.OpenStandardOutput()));
        var errorTask=Task.Run(()=>CopyBounded(error,Console.OpenStandardError()));
        if(WaitForSingleObject(child.process,0xffffffff)!=0)throw new InvalidOperationException("WORKER_WAIT");
        uint code;Check(GetExitCodeProcess(child.process,out code),"WORKER_EXIT");
        // Process exit does not grant a second writer: the outer Keeper observes
        // all Job members, including descendants retaining these stream handles.
        if(!Task.WaitAll(new Task[]{outputTask,errorTask},10000))throw new TimeoutException("WORKER_STREAM_DRAIN");
        CloseProtocolInput(input,inputHandle,writer,writerHandle,writeTask);
        finished=true;return unchecked((int)code);
      }
    } finally {
      if(password!=null)Array.Clear(password,0,password.Length);
      if(pin.IsAllocated)pin.Free();
      if(username!=null)Array.Clear(username,0,username.Length);
      if(configuration!=null)Array.Clear(configuration,0,configuration.Length);
      try {if(!finished)TerminateAndWait(child.process);}
      finally {
        try {CloseProtocolInput(input,inputHandle,writer,writerHandle,writeTask);}
        finally {
          if(reader!=null)reader.Dispose();if(error!=null)error.Dispose();
          Close(ref child.thread);Close(ref child.process);Close(ref runner);Close(ref job);
          Close(ref childToken);Close(ref profileToken);
          Close(ref childRead);Close(ref parentWrite);Close(ref parentRead);Close(ref childWrite);Close(ref errorRead);Close(ref errorWrite);
        }
      }
    }
  }
  static int Main(string[] args) {
    try {
      if(args.Length==1&&args[0]=="--version"){Console.WriteLine(Build);return 0;}
      if(args.Length!=1||args[0]!="--launch")throw new ArgumentException();
      return Run();
    } catch(Exception error){Console.Error.WriteLine("WORKER_LAUNCH_REFUSED:"+
      (error.Message=="PROFILE_NOT_PROVISIONED"||error.Message=="PROFILE_BINDING_REFUSED"?error.Message:error.GetType().Name)
#if TEST_FAULT
      +":"+profilePhase+":WIN32_"+profileWin32Error+":CHILD_PID_"+profileChildPid
      +":EXPECTED_PROFILE_"+profileExpectedRoot+":ACTUAL_PROFILE_"+profileActualRoot
#endif
      );return 90;}
  }
}
