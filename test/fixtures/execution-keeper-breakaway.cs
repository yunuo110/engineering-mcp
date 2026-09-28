using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
    ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static int Main(string[] args) {
    if (args.Length != 2) return 2;
    var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
    PROCESS_INFORMATION child;
    // A cooperating process in the execution Job attempts an explicit escape.
    bool started = CreateProcess(args[0], new StringBuilder("\"" + args[0] + "\" -e \"setTimeout(() => {}, 5000)\""),
      IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000,
      IntPtr.Zero, null, ref startup, out child);
    int error = started ? 0 : Marshal.GetLastWin32Error();
    File.WriteAllText(Path.Combine(args[1], "breakaway.json"),
      "{\"started\":" + (started ? "true" : "false") + ",\"pid\":" + (started ? child.dwProcessId : 0)
      + ",\"error\":" + error + "}");
    if (started) { CloseHandle(child.hThread); CloseHandle(child.hProcess); }
    return 0;
  }
}
