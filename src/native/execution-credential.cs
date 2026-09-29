// One-shot CurrentUser DPAPI primitive. No path, identity, or secret is accepted
// on the command line. Provisioning and runtime ACLs are separate boundaries.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class ExecutionCredential {
  const string Build = "engineering-execution-credential/1";
  const uint CRYPTPROTECT_UI_FORBIDDEN = 0x00000001;
  const uint HANDLE_FLAG_INHERIT = 0x00000001;
  const int MaxFrame = 4 * 4 + 2 * 256 + 2 * 1024;
  const int MaxEnvelope = 16 * 1024;
  const int HeaderLength = 16;
  static readonly byte[] Magic = Encoding.ASCII.GetBytes("EMCPCRED");

  [StructLayout(LayoutKind.Sequential)] struct DATA_BLOB {
    public int cbData; public IntPtr pbData;
  }
  [DllImport("crypt32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CryptProtectData(ref DATA_BLOB input, IntPtr description,
    IntPtr entropy, IntPtr reserved, IntPtr prompt, uint flags, out DATA_BLOB output);
  [DllImport("crypt32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CryptUnprotectData(ref DATA_BLOB input, IntPtr description,
    IntPtr entropy, IntPtr reserved, IntPtr prompt, uint flags, out DATA_BLOB output);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int which, IntPtr value);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  sealed class Refusal : Exception {
    public readonly string Kind;
    public readonly int Code;
    public Refusal(string kind, int code = 0) { Kind = kind; Code = code; }
  }
  static FileStream OwnStandardHandle(int which, FileAccess access) {
    IntPtr raw = GetStdHandle(which);
    if (raw == IntPtr.Zero || raw == new IntPtr(-1)) throw new Refusal("IO");
    var owned = new SafeFileHandle(raw, true);
    try {
      if (!SetHandleInformation(raw, HANDLE_FLAG_INHERIT, 0) ||
        !SetStdHandle(which, IntPtr.Zero)) throw new Refusal("IO");
      // Keep the framework's stream buffer at one byte for secret transport.
      return new FileStream(owned, access, 1, false);
    } catch { owned.Dispose(); throw; }
  }
  static void ZeroNative(IntPtr pointer, int length) {
    if (pointer == IntPtr.Zero || length <= 0) return;
    byte[] zeros = new byte[Math.Min(length, 4096)];
    for (int offset = 0; offset < length; offset += zeros.Length)
      Marshal.Copy(zeros, 0, IntPtr.Add(pointer, offset), Math.Min(zeros.Length, length - offset));
  }
  static DATA_BLOB CopyToNative(byte[] data) {
    var blob = new DATA_BLOB { cbData = data.Length, pbData = Marshal.AllocHGlobal(data.Length) };
    try { Marshal.Copy(data, 0, blob.pbData, data.Length); return blob; }
    catch { ZeroNative(blob.pbData, blob.cbData); Marshal.FreeHGlobal(blob.pbData); throw; }
  }
  static void FreeInput(ref DATA_BLOB blob) {
    ZeroNative(blob.pbData, blob.cbData);
    if (blob.pbData != IntPtr.Zero) Marshal.FreeHGlobal(blob.pbData);
    blob.pbData = IntPtr.Zero; blob.cbData = 0;
  }
  static void FreeOutput(ref DATA_BLOB blob) {
    ZeroNative(blob.pbData, blob.cbData);
    if (blob.pbData != IntPtr.Zero) LocalFree(blob.pbData);
    blob.pbData = IntPtr.Zero; blob.cbData = 0;
  }
  static byte[] ReadBounded(Stream source, int maximum, string kind) {
    using (var buffer = new MemoryStream()) {
      byte[] chunk = new byte[512];
      try {
        int count;
        while ((count = source.Read(chunk, 0, chunk.Length)) != 0) {
          if (buffer.Length + count > maximum) throw new Refusal(kind);
          buffer.Write(chunk, 0, count);
          Array.Clear(chunk, 0, count);
        }
        if (buffer.Length == 0) throw new Refusal(kind);
        return buffer.ToArray();
      } finally {
        Array.Clear(chunk, 0, chunk.Length);
        Array.Clear(buffer.GetBuffer(), 0, (int)buffer.Length);
      }
    }
  }
  static uint Read32(byte[] input, int offset) {
    return (uint)input[offset] | ((uint)input[offset + 1] << 8)
      | ((uint)input[offset + 2] << 16) | ((uint)input[offset + 3] << 24);
  }
  static void Write32(byte[] output, int offset, uint value) {
    output[offset] = (byte)value; output[offset + 1] = (byte)(value >> 8);
    output[offset + 2] = (byte)(value >> 16); output[offset + 3] = (byte)(value >> 24);
  }
  static void ValidateFrame(byte[] frame) {
    if (frame == null || frame.Length < 16 || frame.Length > MaxFrame) throw new Refusal("FRAME");
    int offset = 0;
    for (int field = 0; field < 4; field++) {
      if (offset > frame.Length - 4) throw new Refusal("FRAME");
      uint length = Read32(frame, offset); offset += 4;
      int maximum = (field & 1) == 0 ? 256 : 1024;
      if (length == 0 || length > maximum || length > frame.Length - offset)
        throw new Refusal("FRAME");
      char[] chars = null;
      try {
        if ((field & 1) == 0) {
          chars = new UTF8Encoding(false, true).GetChars(frame, offset, (int)length);
          if (chars.Length == 0) throw new Refusal("FRAME");
          foreach (char c in chars) if (c == '\\' || c == '/' || c == '@' || c == '\0')
            throw new Refusal("FRAME");
        } else {
          if (length < 4 || (length & 1) != 0 || frame[offset + length - 1] != 0
            || frame[offset + length - 2] != 0) throw new Refusal("FRAME");
          chars = new UnicodeEncoding(false, false, true).GetChars(frame, offset, (int)length - 2);
          if (chars.Length == 0) throw new Refusal("FRAME");
          foreach (char c in chars) if (c == '\0') throw new Refusal("FRAME");
        }
      } catch (DecoderFallbackException) { throw new Refusal("FRAME"); }
      finally { if (chars != null) Array.Clear(chars, 0, chars.Length); }
      offset += (int)length;
    }
    if (offset != frame.Length) throw new Refusal("FRAME");
  }
  static byte[] Protect(byte[] frame) {
    DATA_BLOB input = new DATA_BLOB(), output = new DATA_BLOB();
    try {
      input = CopyToNative(frame);
      bool ok = CryptProtectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
        IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out output);
      int error = ok ? 0 : Marshal.GetLastWin32Error();
      if (!ok) throw new Refusal("PROTECT", error);
      if (output.cbData < 1 || output.cbData > MaxEnvelope - HeaderLength)
        throw new Refusal("ENVELOPE");
      byte[] protectedData = new byte[output.cbData];
      try {
        Marshal.Copy(output.pbData, protectedData, 0, protectedData.Length);
        return protectedData;
      } catch { Array.Clear(protectedData, 0, protectedData.Length); throw; }
    } finally { FreeInput(ref input); FreeOutput(ref output); }
  }
  static byte[] Unprotect(byte[] protectedData) {
    DATA_BLOB input = new DATA_BLOB(), output = new DATA_BLOB();
    try {
      input = CopyToNative(protectedData);
      bool ok = CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
        IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out output);
      int error = ok ? 0 : Marshal.GetLastWin32Error();
      if (!ok) throw new Refusal("UNPROTECT", error);
      if (output.cbData < 1 || output.cbData > MaxFrame) throw new Refusal("FRAME");
      byte[] frame = new byte[output.cbData];
      try {
        Marshal.Copy(output.pbData, frame, 0, frame.Length);
        return frame;
      } catch { Array.Clear(frame, 0, frame.Length); throw; }
    } finally { FreeInput(ref input); FreeOutput(ref output); }
  }
  static byte[] Envelope(byte[] protectedData) {
    if (protectedData.Length < 1 || protectedData.Length > MaxEnvelope - HeaderLength)
      throw new Refusal("ENVELOPE");
    byte[] envelope = new byte[HeaderLength + protectedData.Length];
    Buffer.BlockCopy(Magic, 0, envelope, 0, Magic.Length);
    Write32(envelope, 8, 1);
    Write32(envelope, 12, (uint)protectedData.Length);
    Buffer.BlockCopy(protectedData, 0, envelope, HeaderLength, protectedData.Length);
    return envelope;
  }
  static byte[] ParseEnvelope(byte[] envelope) {
    if (envelope.Length < HeaderLength + 1 || envelope.Length > MaxEnvelope)
      throw new Refusal("ENVELOPE");
    for (int index = 0; index < Magic.Length; index++)
      if (envelope[index] != Magic[index]) throw new Refusal("ENVELOPE");
    if (Read32(envelope, 8) != 1) throw new Refusal("ENVELOPE");
    uint length = Read32(envelope, 12);
    if (length < 1 || length > MaxEnvelope - HeaderLength || length != envelope.Length - HeaderLength)
      throw new Refusal("ENVELOPE");
    byte[] protectedData = new byte[length];
    Buffer.BlockCopy(envelope, HeaderLength, protectedData, 0, protectedData.Length);
    return protectedData;
  }
  static void Run(bool seal) {
    byte[] inbound = null, plaintext = null, protectedData = null, outbound = null;
    using (var source = OwnStandardHandle(-10, FileAccess.Read))
    try {
      inbound = ReadBounded(source, seal ? MaxFrame : MaxEnvelope, seal ? "FRAME" : "ENVELOPE");
      if (seal) {
        ValidateFrame(inbound);
        protectedData = Protect(inbound);
        outbound = Envelope(protectedData);
      } else {
        protectedData = ParseEnvelope(inbound);
        plaintext = Unprotect(protectedData);
        ValidateFrame(plaintext);
        outbound = plaintext;
      }
      using (var target = OwnStandardHandle(-11, FileAccess.Write)) {
        target.Write(outbound, 0, outbound.Length);
        target.Flush();
      }
    } finally {
      if (inbound != null) Array.Clear(inbound, 0, inbound.Length);
      if (protectedData != null) Array.Clear(protectedData, 0, protectedData.Length);
      if (outbound != null) Array.Clear(outbound, 0, outbound.Length);
      if (plaintext != null && !Object.ReferenceEquals(plaintext, outbound))
        Array.Clear(plaintext, 0, plaintext.Length);
    }
  }
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") {
      Console.WriteLine(Build); return 0;
    }
    if (args.Length != 1 || (args[0] != "seal" && args[0] != "unseal")) {
      Console.Error.WriteLine("CREDENTIAL_FAILED:ARGUMENTS"); return 86;
    }
    try { Run(args[0] == "seal"); return 0; }
    catch (Refusal error) {
      if (error.Code != 0) Console.Error.WriteLine("CREDENTIAL_FAILED:" + error.Kind + ":" + error.Code);
      else Console.Error.WriteLine("CREDENTIAL_FAILED:" + error.Kind);
      return 86;
    }
    catch {
      Console.Error.WriteLine("CREDENTIAL_FAILED:IO"); return 86;
    }
  }
}
