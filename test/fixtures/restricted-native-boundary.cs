using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static class RestrictedNativeBoundaryTests {
  sealed class ObservedPartialStream : MemoryStream {
    internal byte[] Observed;
    internal ObservedPartialStream() : base(new byte[]{81,82,83}) {}
    public override int Read(byte[] buffer,int offset,int count) { Observed=buffer;return base.Read(buffer,offset,count); }
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved,desktop,title;public int x,y,xsize,ysize,xchars,ychars,fill,flags;
    public short show,reserved2;public IntPtr reservedPointer,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {public IntPtr process,thread;public int pid,tid;}
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES {public IntPtr sid;public uint attributes;}
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_GROUPS_ONE {public uint count;public SID_AND_ATTRIBUTES first;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr attributes,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetStdHandle(int which,IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle,out uint flags);
  static MethodInfo Method(Type type,string name) {return type.GetMethod(name,BindingFlags.NonPublic|BindingFlags.Static);}
  static void Require(bool result) {if(!result)throw new InvalidOperationException("assertion failed");}
  static void Partial(Type type) {
    using(var source=new ObservedPartialStream()) {
      bool refused=false;try{Method(type,"ReadExact").Invoke(null,new object[]{source,10});}catch(TargetInvocationException error){refused=error.InnerException is EndOfStreamException;}
      Require(refused&&source.Observed!=null);
      foreach(byte value in source.Observed)Require(value==0);
    }
  }
  static void ExactCleanup(Type type) {
    string executable=Assembly.GetExecutingAssembly().Location;
    var startup=new STARTUPINFO{cb=Marshal.SizeOf(typeof(STARTUPINFO))};PROCESS_INFORMATION process;
    Require(CreateProcess(executable,new StringBuilder("\""+executable+"\" --sleep"),IntPtr.Zero,IntPtr.Zero,false,4|0x08000000,IntPtr.Zero,Path.GetDirectoryName(executable),ref startup,out process));
    try {
      Require(WaitForSingleObject(process.process,0)==258);
      Method(type,"TerminateAndWait").Invoke(null,new object[]{process.process});
      Require(WaitForSingleObject(process.process,0)==0);
    } finally {if(WaitForSingleObject(process.process,0)!=0){TerminateProcess(process.process,82);WaitForSingleObject(process.process,10000);}CloseHandle(process.thread);CloseHandle(process.process);}
  }
  static void RejectRoles() {
    string core="S-1-5-21-1-2-3-1001",keeper="S-1-5-21-1-2-3-1002",worker="S-1-5-21-1-2-3-1003",op="S-1-5-21-1-2-3-1004";
    foreach(string actual in new string[]{core,keeper,op,"S-1-5-18","S-1-5-21-1-2-3-1005"}) {
      bool refused=false;try{Method(typeof(ExecutionWorker),"ValidateWorkerRoles").Invoke(null,new object[]{actual,worker,core,keeper,op});}catch(TargetInvocationException error){refused=error.InnerException is InvalidOperationException;}
      Require(refused);
    }
    Method(typeof(ExecutionWorker),"ValidateWorkerRoles").Invoke(null,new object[]{worker,worker,core,keeper,op});
  }
  static void AdministratorGroups(Type type,string expectedRefusal) {
    int first=Marshal.OffsetOf(typeof(TOKEN_GROUPS_ONE),"first").ToInt32();
    int size=first+Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    IntPtr buffer=Marshal.AllocHGlobal(size),sidBuffer=Marshal.AllocHGlobal(68);
    try {
      byte[] sid=new byte[68];new SecurityIdentifier("S-1-5-32-544").GetBinaryForm(sid,0);
      Marshal.Copy(sid,0,sidBuffer,sid.Length);Marshal.WriteInt32(buffer,1);Marshal.WriteIntPtr(buffer,first,sidBuffer);
      foreach(uint flags in new uint[]{0,4,16,20}) {
        Marshal.WriteInt32(buffer,first+IntPtr.Size,unchecked((int)flags));
        bool refused=false;
        try {Method(type,"RejectAdministratorGroups").Invoke(null,new object[]{buffer,size});}
        catch(TargetInvocationException error){refused=error.InnerException is InvalidOperationException&&error.InnerException.Message==expectedRefusal;}
        Require(refused);
      }
      new SecurityIdentifier("S-1-5-32-545").GetBinaryForm(sid,0);Marshal.Copy(sid,0,sidBuffer,sid.Length);
      Method(type,"RejectAdministratorGroups").Invoke(null,new object[]{buffer,size});
    } finally {Marshal.FreeHGlobal(sidBuffer);Marshal.FreeHGlobal(buffer);}
  }
  static void OwnedInput(Type type) {
    IntPtr read,write;Require(CreatePipe(out read,out write,IntPtr.Zero,0));
    IntPtr original=GetStdHandle(-10),raw=read;FileStream stream=null;
    try {
      Require(SetStdHandle(-10,read));read=IntPtr.Zero;
      object[] arguments=new object[]{null};
      stream=(FileStream)Method(type,"OpenOwnedStandardInput").Invoke(null,arguments);
      Require(GetStdHandle(-10)==IntPtr.Zero);
      Require(SetStdHandle(-10,original));
      stream.Dispose();uint flags;
      Require(((SafeFileHandle)arguments[0]).IsClosed&&!GetHandleInformation(raw,out flags));
    } finally {SetStdHandle(-10,original);if(stream!=null)stream.Dispose();if(read!=IntPtr.Zero)CloseHandle(read);CloseHandle(write);}
  }
  static void CancelBlockedPipe(bool writing) {
    IntPtr read,write;Require(CreatePipe(out read,out write,IntPtr.Zero,0));
    SafeFileHandle owned=new SafeFileHandle(writing?write:read,true);
    FileStream stream=new FileStream(owned,writing?FileAccess.Write:FileAccess.Read,1,false);
    using(var started=new ManualResetEventSlim(false)) {
      Task pump=Task.Run(()=>{
        started.Set();
        try {if(writing){byte[] bytes=new byte[65536];stream.Write(bytes,0,bytes.Length);stream.Flush();}else stream.ReadByte();}
        catch(IOException){}catch(ObjectDisposedException){}
      });
      try {
        Require(started.Wait(2000));
        Method(typeof(ExecutionWorker),"CloseProtocolInput").Invoke(null,writing
          ?new object[]{null,null,stream,owned,pump}:new object[]{stream,owned,null,null,pump});
        Require(pump.IsCompleted&&owned.IsClosed);
        uint flags;Require(!GetHandleInformation(writing?write:read,out flags));
      } finally {
        // Closing the opposite endpoint also unblocks a failed cancellation
        // test; no account or arbitrary process is involved.
        CloseHandle(writing?read:write);owned.Dispose();stream.Dispose();
        try{pump.Wait(2000);}catch(AggregateException){}
      }
    }
  }
  static void FixedLaunchContract(Type type) {
    Method(type,"ValidateLogonCommand").Invoke(null,new object[]{new StringBuilder(new string('x',1024))});
    bool refused=false;
    try{Method(type,"ValidateLogonCommand").Invoke(null,new object[]{new StringBuilder(new string('x',1025))});}
    catch(TargetInvocationException error){refused=error.InnerException is InvalidOperationException&&error.InnerException.Message=="LOGON_COMMAND_LENGTH";}
    Require(refused);
    IntPtr environment=(IntPtr)Method(type,"MinimalEnvironment").Invoke(null,new object[0]);
    try {
      string expected="HOMEDRIVE=C:\0HOMEPATH=\\\0SystemRoot=C:\\Windows\0\0";
      char[] actual=new char[expected.Length];Marshal.Copy(environment,actual,0,actual.Length);
      Require(new string(actual)==expected);
    } finally {Marshal.FreeHGlobal(environment);}
    if(type==typeof(ExecutionBootstrap)) {
      IntPtr runnerEnvironment=(IntPtr)Method(type,"RunnerEnvironment").Invoke(null,
        new object[]{@"C:\Windows\System32"});
      try {
        string expected="HOMEDRIVE=C:\0HOMEPATH=\\\0LOCALAPPDATA=C:\\Windows\0SystemRoot=C:\\Windows\0\0";
        char[] actual=new char[expected.Length];Marshal.Copy(runnerEnvironment,actual,0,actual.Length);
        Require(new string(actual)==expected);
      } finally {Marshal.FreeHGlobal(runnerEnvironment);}
    }
  }
  static int Main(string[] args) {
    if(args.Length==1&&args[0]=="--sleep"){Thread.Sleep(30000);return 0;}
    try {
      Partial(typeof(ExecutionBootstrap));Partial(typeof(ExecutionWorker));
      ExactCleanup(typeof(ExecutionBootstrap));ExactCleanup(typeof(ExecutionWorker));RejectRoles();
      AdministratorGroups(typeof(ExecutionWorker),"WORKER_ADMIN_GROUP");
      AdministratorGroups(typeof(ExecutionBootstrap),"KEEPER_ADMIN_GROUP");
      OwnedInput(typeof(ExecutionBootstrap));OwnedInput(typeof(ExecutionWorker));CancelBlockedPipe(false);CancelBlockedPipe(true);
      FixedLaunchContract(typeof(ExecutionBootstrap));FixedLaunchContract(typeof(ExecutionWorker));
      Console.WriteLine("{\"partial_secret_clear\":2,\"exact_suspended_child_cleanup\":2,\"role_rejections\":5,\"role_acceptance_unit\":1,\"administrator_attribute_rejections\":{\"worker\":4,\"keeper\":4},\"non_administrator_group_unit\":{\"worker\":1,\"keeper\":1},\"owned_stdin_closed\":2,\"blocked_pipe_cancelled\":2,\"logon_command_boundaries\":4,\"explicit_environment_blocks\":2,\"real_alternate_identity\":\"NOT_RUN\"}");return 0;
    } catch(Exception){Console.Error.WriteLine("NATIVE_BOUNDARY_TEST_FAILED");return 1;}
  }
}
