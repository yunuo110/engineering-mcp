// Development-only cross-SID bootstrap. The credential arrives on an anonymous
// stdin pipe; it is never accepted as an argument, environment value, or file.
using System;
using System.ComponentModel;
using System.IO;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;

internal static class ExecutionBootstrap {
  const string Build = "engineering-execution-bootstrap/2";
  static string Phase = "ARGUMENTS";
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const int STARTF_USESTDHANDLES = 0x00000100;
  const uint HANDLE_FLAG_INHERIT = 1;
  const uint JOB_OBJECT_QUERY = 0x0004;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint TOKEN_QUERY = 0x0008;
  const uint TOKEN_DUPLICATE = 0x0002;
  const int JobObjectExtendedLimitInformation = 9;
  const uint FORBIDDEN_JOB_LIMITS = 0x00000800 | 0x00001000 | 0x00002000;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES {
    public IntPtr sid; public uint attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_GROUPS_ONE {
    public uint count; public SID_AND_ATTRIBUTES first;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
    public STARTUPINFO startup; public IntPtr attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(
    IntPtr job, int infoClass, ref EXTENDED_LIMIT info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(
    IntPtr job, int infoClass, IntPtr buffer, int length, out int returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(
    IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(
    string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr environment, string directory,
    ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessWithLogonW(
    string username, string domain, IntPtr password, uint logonFlags, string application,
    StringBuilder commandLine, uint flags, IntPtr environment, string directory,
    ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(
    out IntPtr read, out IntPtr write, IntPtr attributes, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(
    IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetStdHandle(int which,IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(
    IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle,
    uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(
    IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(
    IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(
    IntPtr token,int kind,IntPtr buffer,int size,out int returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", EntryPoint="CreateProcessW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessExtended(
    string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr environment, string directory,
    ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr attributes,uint disposition,uint flags,IntPtr template);

  static void Check(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static void Close(ref IntPtr handle) {
    if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
  }
  static void Close(ref PROCESS_INFORMATION process) {
    Close(ref process.hThread); Close(ref process.hProcess);
  }
  static FileStream OpenOwnedStandardInput(out SafeFileHandle owned) {
    IntPtr raw=GetStdHandle(-10);owned=null;
    if(raw==IntPtr.Zero||raw==new IntPtr(-1))throw new InvalidOperationException("SECRET_INPUT_HANDLE");
    owned=new SafeFileHandle(raw,true);
    try {
      Check(SetHandleInformation(raw,HANDLE_FLAG_INHERIT,0),"secret input inheritance");
      Check(SetStdHandle(-10,IntPtr.Zero),"detach owned secret input");
      // A one-byte buffer prevents secret-prefetch copies in FileStream.
      return new FileStream(owned,FileAccess.Read,1,false);
    } catch {owned.Dispose();throw;}
  }
  static void ValidateLogonCommand(StringBuilder command) {
    if(command.Length>1024)throw new InvalidOperationException("LOGON_COMMAND_LENGTH");
  }
  static FileStream Own(ref IntPtr handle,FileAccess access) {
    var owned=new SafeFileHandle(handle,true);handle=IntPtr.Zero;
    try {return new FileStream(owned,access);}
    catch {owned.Dispose();throw;}
  }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes).Append(c);
      slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  static byte[] ReadExact(Stream stream, int length) {
    byte[] data = new byte[length]; int offset = 0;
    try {
      while (offset < length) {
        int count = stream.Read(data, offset, length - offset);
        if (count <= 0) throw new EndOfStreamException("secret channel closed");
        offset += count;
      }
      return data;
    } catch { Array.Clear(data, 0, data.Length); throw; }
  }
  static void TerminateAndWait(IntPtr process) {
    if (process == IntPtr.Zero || WaitForSingleObject(process, 0) == 0) return;
    Check(TerminateProcess(process, 82), "Terminate uncommitted child");
    if (WaitForSingleObject(process, 10000) != 0)
      throw new InvalidOperationException("uncommitted child did not exit");
  }
  static void WriteField(Stream target, byte[] value) {
    byte[] header = BitConverter.GetBytes(value.Length);
    try { target.Write(header, 0, header.Length); target.Write(value, 0, value.Length); }
    finally { Array.Clear(header, 0, header.Length); }
  }
  static int ReadLength(Stream stream, int maximum) {
    byte[] header = ReadExact(stream, 4);
    try {
      int length = BitConverter.ToInt32(header, 0);
      if (length < 1 || length > maximum) throw new InvalidDataException("invalid secret frame");
      return length;
    } finally { Array.Clear(header, 0, header.Length); }
  }
  static string Identity(IntPtr process) {
    IntPtr token = IntPtr.Zero;
    try {
      Phase += "/OPEN_TOKEN";
      Check(OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, out token), "OpenProcessToken");
      Phase += "/WINDOWS_IDENTITY";
      using (var identity = new WindowsIdentity(token)) {
        Phase += "/ADMIN_CHECK";
        if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
          throw new InvalidOperationException("alternate identity is administrator");
        Phase += "/SID";
        return identity.User.Value;
      }
    } finally { Close(ref token); }
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
      // No attributes filter: disabled and deny-only administrator membership
      // also disqualify Keeper. Core/Runner policy is unchanged.
      if(new SecurityIdentifier(sid).Value=="S-1-5-32-544")
        throw new InvalidOperationException("KEEPER_ADMIN_GROUP");
    }
  }
  static void RequireKeeperNonAdministrator(IntPtr process) {
    IntPtr token=IntPtr.Zero;
    try {
      Check(OpenProcessToken(process,TOKEN_QUERY,out token),"Keeper token groups open");
      int size;GetTokenInformation(token,2,IntPtr.Zero,0,out size);
      if(size<4||size>65536)throw new InvalidOperationException("TOKEN_GROUPS_SIZE");
      IntPtr groups=Marshal.AllocHGlobal(size);
      try {
        int returned;Check(GetTokenInformation(token,2,groups,size,out returned),"Keeper token groups query");
        if(returned<0||returned>size)throw new InvalidOperationException("TOKEN_GROUPS_SIZE");
        RejectAdministratorGroups(groups,returned);
      } finally {Marshal.FreeHGlobal(groups);}
    } finally {Close(ref token);}
  }
  static IntPtr MinimalEnvironment() {
    // Explicit development values, not a claim about a user's profile.
    // CreateProcessWithLogonW supplies HOMEDRIVE/HOMEPATH if omitted.
    return Marshal.StringToHGlobalUni("HOMEDRIVE=C:\0HOMEPATH=\\\0SystemRoot=C:\\Windows\0\0");
  }
  static IntPtr RunnerEnvironment(string repoRoot) {
    // The disposable Core identity has no loaded user profile. Give the
    // Runner's per-dispatch scratch files a Worker-writable sibling of the
    // verified repository instead of falling back to os.homedir().
    string workspace = Path.GetDirectoryName(repoRoot);
    if (String.IsNullOrEmpty(workspace) || !Path.IsPathRooted(workspace)
      || workspace.IndexOf('\0') >= 0 || !Directory.Exists(workspace))
      throw new InvalidOperationException("RUNNER_WORKSPACE_ROOT");
    return Marshal.StringToHGlobalUni("HOMEDRIVE=C:\0HOMEPATH=\\\0LOCALAPPDATA="
      + workspace + "\0SystemRoot=C:\\Windows\0\0");
  }
  static void VerifyJob(IntPtr job, IntPtr runner) {
    bool member;
    Check(IsProcessInJob(runner, job, out member), "IsProcessInJob");
    if (!member) throw new InvalidOperationException("Runner outside Job");
    int size = Marshal.SizeOf(typeof(EXTENDED_LIMIT));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      int returned;
      Check(QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, size, out returned),
        "QueryInformationJobObject");
      var policy = (EXTENDED_LIMIT)Marshal.PtrToStructure(buffer, typeof(EXTENDED_LIMIT));
      if ((policy.BasicLimitInformation.LimitFlags & FORBIDDEN_JOB_LIMITS) != 0)
        throw new InvalidOperationException("unsafe Job policy");
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static string ReadLineBounded(StreamReader reader, int timeoutMs) {
    var pending = Task.Run(() => reader.ReadLine());
    if (!pending.Wait(timeoutMs)) throw new TimeoutException("Keeper handoff timed out");
    string line = pending.Result;
    if (line == null || line.Length > 256) throw new InvalidDataException("invalid Keeper handoff");
    return line;
  }
  static void Run(string[] args) {
    if (args.Length != 10 || args[0] != "launch")
      throw new ArgumentException("fixed launch arguments required");
    string witnessPath = Path.GetFullPath(args[1]);
    string nodePath = Path.GetFullPath(args[2]);
    string runnerEntry = Path.GetFullPath(args[3]);
    string keeperPath = Path.GetFullPath(args[4]);
    string storePath = Path.GetFullPath(args[5]);
    string repoRoot = Path.GetFullPath(args[6]);
    string dispatchId = Guid.Parse(args[7]).ToString("D");
    string instanceId = Guid.Parse(args[8]).ToString("D");
    string keeperSid = new SecurityIdentifier(args[9]).Value;
    if (!Path.IsPathRooted(args[1]) || !Path.IsPathRooted(args[2]) || !Path.IsPathRooted(args[3])
      || !Path.IsPathRooted(args[4]) || !Path.IsPathRooted(args[5]) || !Path.IsPathRooted(args[6])
      || !File.Exists(witnessPath) || !File.Exists(nodePath) || !File.Exists(runnerEntry)
      || !File.Exists(keeperPath) || !Directory.Exists(repoRoot)
      || !String.Equals(Path.GetFileName(witnessPath), "bootstrap.json", StringComparison.OrdinalIgnoreCase))
      throw new ArgumentException("invalid fixed bootstrap paths");

    // The frame contains Keeper then Worker username/password field pairs.
    // Usernames are UTF-8 and passwords NUL-terminated UTF-16. Only the pinned
    // Keeper password byte buffer is passed to CreateProcessWithLogonW here.
    SafeFileHandle secretHandle;
    Stream secret = OpenOwnedStandardInput(out secretHandle);
    byte[] userBytes = null, password = null, workerUser = null, workerPassword = null;
    GCHandle pinned = new GCHandle();
    IntPtr job = IntPtr.Zero, environment = IntPtr.Zero, runnerEnvironment = IntPtr.Zero;
    IntPtr keeperInputRead = IntPtr.Zero, helperInputWrite = IntPtr.Zero;
    IntPtr helperOutputRead = IntPtr.Zero, keeperOutputWrite = IntPtr.Zero;
    IntPtr runnerInputRead = IntPtr.Zero, helperRunnerInputWrite = IntPtr.Zero, runnerOutputNull = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, inheritedList = IntPtr.Zero;
    PROCESS_INFORMATION runner = new PROCESS_INFORMATION(), keeper = new PROCESS_INFORMATION();
    bool committed = false, attributesInitialized = false;
    try {
      Phase = "SECRET_CHANNEL";
      userBytes = ReadExact(secret, ReadLength(secret, 256));
      password = ReadExact(secret, ReadLength(secret, 1024));
      workerUser = ReadExact(secret, ReadLength(secret, 256));
      workerPassword = ReadExact(secret, ReadLength(secret, 1024));
      foreach (int which in new int[] { -10, -11, -12 }) {
        IntPtr handle = GetStdHandle(which);
        if (handle != IntPtr.Zero && handle != new IntPtr(-1))
          Check(SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0), "clear bootstrap standard inheritance");
      }
      secret.Close();
      if (password.Length < 4 || (password.Length & 1) != 0
        || password[password.Length - 1] != 0 || password[password.Length - 2] != 0)
        throw new InvalidDataException("invalid password frame");
      if (workerPassword.Length < 4 || (workerPassword.Length & 1) != 0
        || workerPassword[workerPassword.Length - 1] != 0 || workerPassword[workerPassword.Length - 2] != 0)
        throw new InvalidDataException("invalid Worker password frame");
      string username = new UTF8Encoding(false, true).GetString(userBytes);
      if (username.Length == 0 || username.IndexOfAny(new char[] { '\\', '/', '@', '\0' }) >= 0)
        throw new InvalidDataException("local test username required");
      pinned = GCHandle.Alloc(password, GCHandleType.Pinned);
      environment = MinimalEnvironment();
      runnerEnvironment = RunnerEnvironment(repoRoot);

      Phase = "JOB_CREATE";
      job = CreateJobObject(IntPtr.Zero, IntPtr.Zero); // Unnamed, never reopened by name.
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
      var limits = new EXTENDED_LIMIT();
      Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
        Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "SetInformationJobObject");
      Check(CreatePipe(out runnerInputRead, out helperRunnerInputWrite, IntPtr.Zero, 0), "Runner secret pipe");
      runnerOutputNull = CreateFile("NUL", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (runnerOutputNull == new IntPtr(-1)) { runnerOutputNull = IntPtr.Zero; throw new Win32Exception(Marshal.GetLastWin32Error(), "Runner null output"); }
      Check(SetHandleInformation(runnerInputRead, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "Runner input inheritance");
      Check(SetHandleInformation(runnerOutputNull, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "Runner output inheritance");
      IntPtr attributeSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      attributes = Marshal.AllocHGlobal(attributeSize);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize), "Runner handle list initialize");
      attributesInitialized = true;
      inheritedList = Marshal.AllocHGlobal(2 * IntPtr.Size);
      Marshal.WriteIntPtr(inheritedList, 0, runnerInputRead); Marshal.WriteIntPtr(inheritedList, IntPtr.Size, runnerOutputNull);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), inheritedList,
        new IntPtr(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Runner handle allowlist");
      var runnerStartup = new STARTUPINFOEX { attributes = attributes,
        startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFOEX)), dwFlags = STARTF_USESTDHANDLES,
          hStdInput = runnerInputRead, hStdOutput = runnerOutputNull, hStdError = runnerOutputNull } };
      var runnerCommand = new StringBuilder(Quote(nodePath) + " " + Quote(runnerEntry) + " --store "
        + Quote(storePath) + " --repo " + Quote(repoRoot) + " --dispatch " + Quote(dispatchId)
        + " --execution-instance " + Quote(instanceId) + " --worker-secret-stdin");
      Phase = "RUNNER_CREATE";
      Check(CreateProcessExtended(nodePath, runnerCommand, IntPtr.Zero, IntPtr.Zero, true,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        runnerEnvironment, repoRoot, ref runnerStartup, out runner), "CreateProcess Runner");
      Close(ref runnerInputRead); Close(ref runnerOutputNull);
      Phase = "RUNNER_TOKEN_QUERY";
      if (Identity(runner.hProcess) != WindowsIdentity.GetCurrent().User.Value)
        throw new InvalidOperationException("Runner token differs from Core");
      Phase = "JOB_ASSIGN";
      Check(AssignProcessToJobObject(job, runner.hProcess), "AssignProcessToJobObject");
      VerifyJob(job, runner.hProcess);
      IntPtr runnerJob;
      Check(DuplicateHandle(GetCurrentProcess(), job, runner.hProcess, out runnerJob,
        JOB_OBJECT_QUERY | 1, false, 0), "Runner Job assignment handle");
      using (var workerChannel = Own(ref helperRunnerInputWrite,FileAccess.Write)) {
        byte[] handleBytes = BitConverter.GetBytes(runnerJob.ToInt64());
        try {
          workerChannel.Write(handleBytes, 0, handleBytes.Length);
          WriteField(workerChannel, workerUser); WriteField(workerChannel, workerPassword); workerChannel.Flush();
        } finally { Array.Clear(handleBytes, 0, handleBytes.Length); }
      }
      Array.Clear(workerPassword, 0, workerPassword.Length); workerPassword = null;
      Array.Clear(workerUser, 0, workerUser.Length); workerUser = null;
      long creation, exited, kernel, user;
      Check(GetProcessTimes(runner.hProcess, out creation, out exited, out kernel, out user), "GetProcessTimes");

      Check(CreatePipe(out keeperInputRead, out helperInputWrite, IntPtr.Zero, 0), "CreatePipe input");
      Check(CreatePipe(out helperOutputRead, out keeperOutputWrite, IntPtr.Zero, 0), "CreatePipe output");
      Check(SetHandleInformation(keeperInputRead, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "inherit input");
      Check(SetHandleInformation(keeperOutputWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "inherit output");
      var keeperStartup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)),
        dwFlags = STARTF_USESTDHANDLES, hStdInput = keeperInputRead,
        hStdOutput = keeperOutputWrite, hStdError = keeperOutputWrite };
      var keeperCommand = new StringBuilder(Quote(keeperPath) + " observe " + Quote(witnessPath)
        + " " + Quote(storePath) + " " + Quote(repoRoot) + " " + Quote(dispatchId)
        + " " + Quote(instanceId) + " " + Quote(WindowsIdentity.GetCurrent().User.Value));
      ValidateLogonCommand(keeperCommand);
      Phase = "KEEPER_CREATE";
      // Do not load a disposable user's persistent profile in this isolated test.
      Check(CreateProcessWithLogonW(username, ".", pinned.AddrOfPinnedObject(), 0,
        keeperPath, keeperCommand, CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        environment, Path.GetDirectoryName(keeperPath), ref keeperStartup, out keeper),
        "CreateProcessWithLogonW Keeper");
      Array.Clear(password, 0, password.Length); pinned.Free(); password = null;
      Phase = "KEEPER_TOKEN_QUERY";
      RequireKeeperNonAdministrator(keeper.hProcess);
      if (Identity(keeper.hProcess) != keeperSid)
        throw new InvalidOperationException("Keeper SID differs from trusted binding");
      Close(ref keeperInputRead); Close(ref keeperOutputWrite);
      IntPtr keeperJob, keeperRunner;
      Check(DuplicateHandle(GetCurrentProcess(), job, keeper.hProcess, out keeperJob,
        JOB_OBJECT_QUERY, false, 0), "DuplicateHandle Job query");
      Check(DuplicateHandle(GetCurrentProcess(), runner.hProcess, keeper.hProcess, out keeperRunner,
        PROCESS_QUERY_LIMITED_INFORMATION, false, 0), "DuplicateHandle Runner query");
      Phase = "HANDOFF";
      using (var handoff = Own(ref helperInputWrite,FileAccess.Write)) {
        byte[] line = Encoding.ASCII.GetBytes(keeperJob.ToInt64() + " " + keeperRunner.ToInt64()
          + " " + runner.dwProcessId + " " + creation + "\n");
        handoff.Write(line, 0, line.Length); handoff.Flush();
        if (ResumeThread(keeper.hThread) == uint.MaxValue)
          throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread Keeper");
        using (var response = new StreamReader(Own(ref helperOutputRead,FileAccess.Read),
          Encoding.ASCII, false, 256)) {
          string sealedLine = ReadLineBounded(response, 10000);
          if (sealedLine != "SEALED") throw new InvalidDataException("Keeper did not seal");
          if (ResumeThread(runner.hThread) == uint.MaxValue)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread Runner");
          byte[] resumed = Encoding.ASCII.GetBytes("RESUMED\n");
          handoff.Write(resumed, 0, resumed.Length); handoff.Flush();
          if (ReadLineBounded(response, 10000) != "RESUMED")
            throw new InvalidDataException("Keeper did not publish resumed evidence");
          committed = true;
        }
      }
      Phase = "DONE";
    } finally {
      try { secret.Close(); } catch { }
      if (password != null) Array.Clear(password, 0, password.Length);
      if (pinned.IsAllocated) pinned.Free();
      if (userBytes != null) Array.Clear(userBytes, 0, userBytes.Length);
      if (workerPassword != null) Array.Clear(workerPassword, 0, workerPassword.Length);
      if (workerUser != null) Array.Clear(workerUser, 0, workerUser.Length);
      try {
        if (!committed) {
          try { TerminateAndWait(runner.hProcess); }
          finally { TerminateAndWait(keeper.hProcess); }
        }
      } finally {
        Close(ref runner); Close(ref keeper);
        Close(ref keeperInputRead); Close(ref helperInputWrite);
        Close(ref helperOutputRead); Close(ref keeperOutputWrite);
        Close(ref runnerInputRead); Close(ref helperRunnerInputWrite); Close(ref runnerOutputNull);
        Close(ref job);
        if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
        if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
        if (inheritedList != IntPtr.Zero) Marshal.FreeHGlobal(inheritedList);
        if (runnerEnvironment != IntPtr.Zero) Marshal.FreeHGlobal(runnerEnvironment);
        if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
      }
    }
  }
  static int Main(string[] args) {
    try {
      if (args.Length == 1 && args[0] == "--version") { Console.WriteLine(Build); return 0; }
      Run(args); return 0;
    } catch (Exception error) {
      // No exception text: paths and operating-system errors are not log input.
      Console.Error.WriteLine("BOOTSTRAP_FAILED:" + Phase + ":" + error.GetType().Name);
      return 90;
    }
  }
}
