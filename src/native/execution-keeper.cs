// Windows-only, one process and one unnamed Job per C2C execution attempt.
// The Keeper never joins the Job and never mutates Task or dispatch state.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Text.RegularExpressions;

internal sealed class ExecutionKeeper {
  const int Version = 1;
  const string Build = "engineering-execution-keeper/1";
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint FORBIDDEN_JOB_LIMITS = 0x00000800 | 0x00001000 | 0x00002000;
  const int JobObjectBasicAccountingInformation = 1;
  const int JobObjectBasicProcessIdList = 3;
  const int JobObjectExtendedLimitInformation = 9;
  const int ERROR_MORE_DATA = 234;

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
  [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING {
    public long TotalUserTime; public long TotalKernelTime;
    public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses;
    public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(
    IntPtr job, int infoClass, ref EXTENDED_LIMIT info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(
    IntPtr job, int infoClass, IntPtr buffer, int length, out int returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(
    string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr environment, string directory,
    ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process,
    out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetHandleInformation(
    IntPtr handle, out uint flags);

  readonly string witnessPath;
  readonly string sealedPath;
  readonly string resumedPath;
  readonly string receiptPath;
  readonly string witnessId;
  readonly string dispatchId;
  readonly string instanceId;
  readonly string bindingHash;
  readonly string pipeName;
  readonly string coreSid;
  readonly bool observer;
  readonly object drainLock = new object();
  IntPtr job;
  int runnerPid;
  long runnerCreation;
  string sealedHash;
  volatile bool drained;

  ExecutionKeeper(string[] args) {
    observer = args.Length == 7 && args[0] == "observe";
    if (!observer && (args.Length != 8 || args[0] != "launch"))
      throw new ArgumentException("fixed launch arguments required");
    witnessPath = args[1];
    string nodePath = observer ? null : args[2], runnerEntry = observer ? null : args[3];
    string storePath = observer ? args[2] : args[4], repoRoot = observer ? args[3] : args[5];
    dispatchId = Guid.Parse(observer ? args[4] : args[6]).ToString("D");
    instanceId = Guid.Parse(observer ? args[5] : args[7]).ToString("D");
    coreSid = observer ? new SecurityIdentifier(args[6]).Value : WindowsIdentity.GetCurrent().User.Value;
    string controlDir = Path.GetDirectoryName(witnessPath);
    string executionDir = controlDir == null ? null : Path.GetDirectoryName(controlDir);
    string keeperDir = executionDir == null ? null : Path.Combine(executionDir, "keeper");
    sealedPath = keeperDir == null ? null : Path.Combine(keeperDir, "runtime.sealed.json");
    resumedPath = keeperDir == null ? null : Path.Combine(keeperDir, "runtime.resumed.json");
    receiptPath = keeperDir == null ? null : Path.Combine(keeperDir, "drain-receipt.json");
    if (!Path.IsPathRooted(witnessPath) || (!observer && (!Path.IsPathRooted(nodePath) || !Path.IsPathRooted(runnerEntry)))
      || !Path.IsPathRooted(storePath) || !Path.IsPathRooted(repoRoot)
      || !String.Equals(Path.GetFileName(witnessPath), "bootstrap.json", StringComparison.OrdinalIgnoreCase)
      || !String.Equals(Path.GetFileName(controlDir), "control", StringComparison.OrdinalIgnoreCase)
      || !String.Equals(Path.GetFileName(executionDir), dispatchId, StringComparison.OrdinalIgnoreCase)
      || !Directory.Exists(keeperDir)
      || (!observer && (!String.Equals(Path.GetFileName(nodePath), "node.exe", StringComparison.OrdinalIgnoreCase)
        || !File.Exists(nodePath) || !File.Exists(runnerEntry))) || !File.Exists(witnessPath)
      || File.Exists(sealedPath) || File.Exists(resumedPath) || File.Exists(receiptPath))
      throw new ArgumentException("invalid local bootstrap paths");
    var bootstrap = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(witnessPath));
    if (bootstrap == null || !bootstrap.ContainsKey("version") || !bootstrap.ContainsKey("state")
      || !bootstrap.ContainsKey("dispatch_run_id") || !bootstrap.ContainsKey("runner_instance_id")
      || Convert.ToInt32(bootstrap["version"]) != Version
      || !String.Equals(Convert.ToString(bootstrap["state"]), "BOOTSTRAPPING", StringComparison.Ordinal)
      || !String.Equals(Convert.ToString(bootstrap["dispatch_run_id"]), dispatchId, StringComparison.Ordinal)
      || !String.Equals(Convert.ToString(bootstrap["runner_instance_id"]), instanceId, StringComparison.Ordinal))
      throw new ArgumentException("bootstrap identity mismatch");
    witnessId = Guid.NewGuid().ToString("N");
    pipeName = "EngineeringMCP.Execution." + witnessId;
    bindingHash = Sha(storePath + "\0" + repoRoot);
    NodePath = nodePath; RunnerEntry = runnerEntry; StorePath = storePath; RepoRoot = repoRoot;
  }
  readonly string NodePath, RunnerEntry, StorePath, RepoRoot;

  static void Check(bool success, string operation) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static string Sha(string value) {
    using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value)))
      .Replace("-", "").ToLowerInvariant();
  }
  static string Quote(string value) {
    var text = new StringBuilder("\""); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      text.Append('\\', character == '"' ? slashes * 2 + 1 : slashes).Append(character);
      slashes = 0;
    }
    return text.Append('\\', slashes * 2).Append('"').ToString();
  }
  static byte[] Json(object value) { return new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(value)); }
  static void AtomicWrite(string path, byte[] content) {
    string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
    using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
      file.Write(content, 0, content.Length); file.Flush(true);
    }
    try {
      File.Move(temp, path); // Create once. Existing evidence is never replaced.
    } finally {
      if (File.Exists(temp)) File.Delete(temp);
    }
  }
  PipeSecurity LocalPipeSecurity() {
    var security = new PipeSecurity();
    var sid = WindowsIdentity.GetCurrent().User;
    security.SetAccessRuleProtection(true, false);
    security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.ReadWrite, AccessControlType.Allow));
    if (coreSid != sid.Value) security.AddAccessRule(new PipeAccessRule(
      new SecurityIdentifier(coreSid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
      PipeAccessRights.FullControl, AccessControlType.Allow));
    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
      PipeAccessRights.FullControl, AccessControlType.Allow));
    return security;
  }
  NamedPipeServerStream NewPipe() {
    return new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
      PipeOptions.None, 256, 4096, LocalPipeSecurity());
  }
  void Bootstrap() {
    job = CreateJobObject(IntPtr.Zero, IntPtr.Zero); // Unnamed: no reopen/name-based recovery.
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
    var limits = new EXTENDED_LIMIT(); // Explicitly no breakaway and no KILL_ON_JOB_CLOSE.
    Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
      Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "SetInformationJobObject");
    var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
    PROCESS_INFORMATION process = new PROCESS_INFORMATION(); bool committed = false;
    try {
      var command = new StringBuilder(Quote(NodePath) + " " + Quote(RunnerEntry) + " --store " + Quote(StorePath)
        + " --repo " + Quote(RepoRoot) + " --dispatch " + Quote(dispatchId)
        + " --execution-instance " + Quote(instanceId));
      Check(CreateProcess(NodePath, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_NO_WINDOW,
        IntPtr.Zero, RepoRoot, ref startup, out process), "CreateProcess");
      Check(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject");
      bool member;
      Check(IsProcessInJob(process.hProcess, job, out member) && member, "IsProcessInJob");
      IntPtr policyBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMIT)));
      try {
        int returned;
        Check(QueryInformationJobObject(job, JobObjectExtendedLimitInformation, policyBuffer,
          Marshal.SizeOf(typeof(EXTENDED_LIMIT)), out returned), "Job policy query");
        var actual = (EXTENDED_LIMIT)Marshal.PtrToStructure(policyBuffer, typeof(EXTENDED_LIMIT));
        if ((actual.BasicLimitInformation.LimitFlags & FORBIDDEN_JOB_LIMITS) != 0)
          throw new InvalidOperationException("unsafe Job policy");
      } finally { Marshal.FreeHGlobal(policyBuffer); }
      long exited, kernel, user;
      Check(GetProcessTimes(process.hProcess, out runnerCreation, out exited, out kernel, out user), "GetProcessTimes");
      runnerPid = process.dwProcessId;
      byte[] sealedBytes = Json(new { version = Version, state = "SEALED", execution_witness_id = witnessId,
        dispatch_run_id = dispatchId, runner_instance_id = instanceId, execution_instance_id = instanceId,
        ledger_repo_binding_sha256 = bindingHash, runner_pid = runnerPid,
        runner_creation_filetime = runnerCreation.ToString(System.Globalization.CultureInfo.InvariantCulture), pipe_name = pipeName,
        breakaway_allowed = false, kill_on_job_close = false, helper_build = Build });
      sealedHash = BitConverter.ToString(SHA256.Create().ComputeHash(sealedBytes)).Replace("-", "").ToLowerInvariant();
      AtomicWrite(sealedPath, sealedBytes); // Before ResumeThread.
#if TEST_FAULT
      string pausePath = Environment.GetEnvironmentVariable("ENGINEERING_V2_TEST_PAUSE_BEFORE_RESUME_FILE");
      if (!String.IsNullOrEmpty(pausePath)) {
        File.WriteAllText(pausePath + ".ready", "SEALED");
        DateTime deadline = DateTime.UtcNow.AddSeconds(15);
        while (!File.Exists(pausePath + ".go") && DateTime.UtcNow < deadline) Thread.Sleep(25);
        if (!File.Exists(pausePath + ".go")) throw new InvalidOperationException("test pause expired");
      }
#endif
      if (ResumeThread(process.hThread) == uint.MaxValue)
        throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
      AtomicWrite(resumedPath, Json(new { version = Version, state = "RESUMED", execution_witness_id = witnessId,
        dispatch_run_id = dispatchId, runner_instance_id = instanceId, execution_instance_id = instanceId,
        ledger_repo_binding_sha256 = bindingHash, runner_pid = runnerPid,
        runner_creation_filetime = runnerCreation.ToString(System.Globalization.CultureInfo.InvariantCulture), pipe_name = pipeName, sealed_sha256 = sealedHash,
        breakaway_allowed = false, kill_on_job_close = false, helper_build = Build }));
      committed = true;
    } finally {
      try {
        if (!committed && process.hProcess != IntPtr.Zero && WaitForSingleObject(process.hProcess, 0) != 0) {
          Check(TerminateProcess(process.hProcess, 82), "Terminate uncommitted Runner");
          if (WaitForSingleObject(process.hProcess, 10000) != 0)
            throw new InvalidOperationException("uncommitted Runner did not exit");
        }
      } finally {
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
        if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      }
    }
  }
  void Observe() {
    // The Core-owned helper duplicated query-only handles into this process.
    // Values are transferred over private standard pipes, never by reopening a
    // named Job or by granting Keeper the Core token.
    string handoff = Console.ReadLine();
    if (String.IsNullOrEmpty(handoff)) throw new InvalidDataException("missing Job handoff");
    string[] parts = handoff.Split(' ');
    if (parts.Length != 4) throw new InvalidDataException("invalid Job handoff");
    long jobValue, runnerValue, expectedCreation; int expectedPid;
    if (!Int64.TryParse(parts[0], out jobValue) || !Int64.TryParse(parts[1], out runnerValue)
      || !Int32.TryParse(parts[2], out expectedPid) || !Int64.TryParse(parts[3], out expectedCreation)
      || jobValue == 0 || runnerValue == 0 || expectedPid <= 0)
      throw new InvalidDataException("invalid Job handle values");
    job = new IntPtr(jobValue);
    IntPtr runner = new IntPtr(runnerValue);
    try {
      uint flags;
      Check(GetHandleInformation(job, out flags), "Keeper Job handle");
      Check(GetHandleInformation(runner, out flags), "Keeper Runner handle");
      bool member;
      Check(IsProcessInJob(runner, job, out member), "Keeper Runner membership");
      if (!member) throw new InvalidOperationException("Runner outside Job");
      long exited, kernel, user;
      Check(GetProcessTimes(runner, out runnerCreation, out exited, out kernel, out user),
        "Keeper Runner creation");
      if (runnerCreation != expectedCreation) throw new InvalidOperationException("Runner creation changed");
      runnerPid = expectedPid;
      byte[] sealedBytes = Json(new { version = Version, state = "SEALED", execution_witness_id = witnessId,
        dispatch_run_id = dispatchId, runner_instance_id = instanceId, execution_instance_id = instanceId,
        ledger_repo_binding_sha256 = bindingHash, runner_pid = runnerPid,
        runner_creation_filetime = runnerCreation.ToString(System.Globalization.CultureInfo.InvariantCulture), pipe_name = pipeName,
        breakaway_allowed = false, kill_on_job_close = false, helper_build = Build });
      using (var hash = SHA256.Create()) sealedHash = BitConverter.ToString(hash.ComputeHash(sealedBytes))
        .Replace("-", "").ToLowerInvariant();
      AtomicWrite(sealedPath, sealedBytes);
      Console.WriteLine("SEALED"); Console.Out.Flush();
      if (Console.ReadLine() != "RESUMED") return; // No resume claim after helper failure.
      AtomicWrite(resumedPath, Json(new { version = Version, state = "RESUMED", execution_witness_id = witnessId,
        dispatch_run_id = dispatchId, runner_instance_id = instanceId, execution_instance_id = instanceId,
        ledger_repo_binding_sha256 = bindingHash, runner_pid = runnerPid,
        runner_creation_filetime = runnerCreation.ToString(System.Globalization.CultureInfo.InvariantCulture), pipe_name = pipeName,
        sealed_sha256 = sealedHash, breakaway_allowed = false, kill_on_job_close = false, helper_build = Build }));
      Console.WriteLine("RESUMED"); Console.Out.Flush();
    } finally { CloseHandle(runner); }
  }
  int ActiveProcesses() {
    int length = Marshal.SizeOf(typeof(BASIC_ACCOUNTING));
    IntPtr buffer = Marshal.AllocHGlobal(length);
    try {
      int returned;
      Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, buffer, length, out returned),
        "Job accounting query");
      var info = (BASIC_ACCOUNTING)Marshal.PtrToStructure(buffer, typeof(BASIC_ACCOUNTING));
      if (info.TotalProcesses == 0) throw new InvalidOperationException("Job never had a process");
      return checked((int)info.ActiveProcesses);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  int[] Pids(int expected) {
    int capacity = Math.Max(4, expected + 4);
    for (int attempt = 0; attempt < 4; attempt++) {
      int length = 8 + capacity * IntPtr.Size;
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        int returned;
        if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, length, out returned)) {
          if (Marshal.GetLastWin32Error() == ERROR_MORE_DATA) { capacity *= 2; continue; }
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Job PID query");
        }
        int count = Marshal.ReadInt32(buffer, 4);
        if (count < 0 || count > capacity || count != expected)
          throw new InvalidOperationException("Job accounting/PID list mismatch");
        int[] pids = new int[count];
        for (int i = 0; i < count; i++) pids[i] = Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt32();
        return pids;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new InvalidOperationException("Job PID list changed during query");
  }
  object Status() {
    lock (drainLock) {
      int active = ActiveProcesses();
      if (active == 0) {
        if (!drained) {
#if TEST_FAULT
          if (Environment.GetEnvironmentVariable("ENGINEERING_V2_TEST_EXIT_BEFORE_RECEIPT") == "1")
            Environment.Exit(91);
#endif
          AtomicWrite(receiptPath, Json(new { version = Version, execution_witness_id = witnessId,
            dispatch_run_id = dispatchId, runner_instance_id = instanceId, execution_instance_id = instanceId,
            ledger_repo_binding_sha256 = bindingHash, sealed_sha256 = sealedHash, runner_pid = runnerPid,
            runner_creation_filetime = runnerCreation.ToString(System.Globalization.CultureInfo.InvariantCulture), observed_active_processes = 0,
            observed_at = DateTime.UtcNow.ToString("o"), helper_build = Build }));
          drained = true;
        }
        return new { version = Version, execution_witness_id = witnessId, dispatch_run_id = dispatchId,
          runner_instance_id = instanceId, state = "DRAINED", active_processes = 0, process_ids = new int[0] };
      }
      int[] pids = Pids(active);
      return new { version = Version, execution_witness_id = witnessId, dispatch_run_id = dispatchId,
        runner_instance_id = instanceId, state = "ALIVE", active_processes = active, process_ids = pids };
    }
  }
  void ServePipe() {
    while (!drained) {
      try {
        using (var pipe = NewPipe()) {
          pipe.WaitForConnection();
          var input = new byte[128]; int count = 0; int value;
          while (count < input.Length && (value = pipe.ReadByte()) >= 0 && value != '\n') input[count++] = (byte)value;
          string line = Encoding.ASCII.GetString(input, 0, count).TrimEnd('\r');
          string response = line == "STATUS 1 " + witnessId
            ? new JavaScriptSerializer().Serialize(Status()) : "ERROR";
          byte[] output = Encoding.UTF8.GetBytes(response + "\n");
          pipe.Write(output, 0, output.Length); pipe.Flush();
        }
      } catch (Exception error) {
        Console.Error.WriteLine("KEEPER_STATUS_ERROR:" + error.GetType().Name + ":" + error.Message);
        // The main thread continues synchronous Job observation; a failed
        // request never manufactures liveness or a drain receipt.
      }
    }
  }
  void Run() {
    try {
      if (observer) Observe(); else Bootstrap();
      if (observer && !File.Exists(resumedPath)) return;
      var listener = new Thread(ServePipe) { IsBackground = true };
      listener.Start();
      while (!drained) {
        try { if (ActiveProcesses() == 0) Status(); }
        catch { return; } // No receipt means UNKNOWN after Keeper exits.
        Thread.Sleep(100);
      }
    } finally { if (job != IntPtr.Zero) CloseHandle(job); }
  }
  static int Main(string[] args) {
    try {
      if (args.Length == 1 && args[0] == "--version") { Console.WriteLine(Build); return 0; }
      if (args.Length == 2 && args[0] == "status"
        && Regex.IsMatch(args[1], "^[0-9a-f]{32}$", RegexOptions.CultureInvariant)) {
        using (var pipe = new NamedPipeClientStream(".", "EngineeringMCP.Execution." + args[1], PipeDirection.InOut)) {
          pipe.Connect(1500);
          byte[] request = Encoding.ASCII.GetBytes("STATUS 1 " + args[1] + "\n");
          pipe.Write(request, 0, request.Length); pipe.Flush();
          var output = new byte[4096]; int count = 0; int value;
          while (count < output.Length && (value = pipe.ReadByte()) >= 0 && value != '\n') output[count++] = (byte)value;
          if (count == output.Length) throw new InvalidOperationException("status response exceeded bound");
          Console.WriteLine(Encoding.UTF8.GetString(output, 0, count));
          return 0;
        }
      }
      new ExecutionKeeper(args).Run(); return 0;
    }
    catch (Exception error) { Console.Error.WriteLine(error.GetType().Name + ":" + error.Message); return 90; }
  }
}
