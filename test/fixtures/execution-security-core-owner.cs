// Test-only owner fixture for Windows runners whose elevated token defaults to
// the Administrators group as the owner of new files. Never staged as runtime.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static class CoreOwnerFixture {
  static readonly InheritanceFlags Both = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern uint GetLongPathName(string shortPath,StringBuilder longPath,uint bufferLength);
  static string ExistingLongPath(string path) {
    var buffer=new StringBuilder(32768);
    uint length=GetLongPathName(Path.GetFullPath(path),buffer,(uint)buffer.Capacity);
    if(length==0 || length>=buffer.Capacity) throw new ArgumentException("test path resolution failed");
    return Path.GetFullPath(buffer.ToString()).TrimEnd(Path.DirectorySeparatorChar);
  }
  static SecurityIdentifier Sid(string value) { return new SecurityIdentifier(value); }
  static void IsolatedRoot(string root) {
    if(!String.Equals(Path.GetFileName(root),"execution-witnesses",StringComparison.Ordinal) ||
      !Path.GetFileName(Path.GetDirectoryName(root)).StartsWith("eng-security-native-",StringComparison.Ordinal))
      throw new ArgumentException("isolated test root required");
    string parent=Path.GetDirectoryName(root);
    if(!Directory.Exists(parent) ||
      (File.GetAttributes(parent)&FileAttributes.ReparsePoint)!=0)
      throw new ArgumentException("isolated test parent required");
    if(!String.Equals(Path.GetDirectoryName(ExistingLongPath(parent)),
      ExistingLongPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase))
      throw new ArgumentException("test root must be a direct child of the current temp directory");
  }
  static void OwnDirectory(string path,SecurityIdentifier owner) {
    var acl=Directory.GetAccessControl(path,AccessControlSections.Owner);
    acl.SetOwner(owner);
    Directory.SetAccessControl(path,acl);
  }
  static void OwnFile(string path,SecurityIdentifier owner) {
    var acl=File.GetAccessControl(path,AccessControlSections.Owner);
    acl.SetOwner(owner);
    File.SetAccessControl(path,acl);
  }
  static void Add(DirectorySecurity acl,SecurityIdentifier sid,FileSystemRights rights,
    InheritanceFlags inheritance,PropagationFlags propagation) {
    acl.AddAccessRule(new FileSystemAccessRule(sid,rights,inheritance,propagation,AccessControlType.Allow));
  }
  static void Main(string[] args) {
    var core=WindowsIdentity.GetCurrent().User;
    if(args.Length==2 && args[0]=="own-root") {
      string witnessRoot=Path.GetFullPath(args[1]);
      IsolatedRoot(witnessRoot);
      if(!Directory.Exists(witnessRoot) ||
        (File.GetAttributes(witnessRoot)&FileAttributes.ReparsePoint)!=0)
        throw new ArgumentException("isolated witness root required");
      OwnDirectory(witnessRoot,core);
      return;
    }
    if(args.Length==2 && args[0]=="own-file") {
      string file=Path.GetFullPath(args[1]);
      string receiptRoot=Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(file)));
      IsolatedRoot(receiptRoot);
      if(Path.GetFileName(file)!="drain-receipt.json" || Path.GetFileName(Path.GetDirectoryName(file))!="keeper")
        throw new ArgumentException("isolated receipt required");
      if(!Directory.Exists(receiptRoot) ||
        (File.GetAttributes(receiptRoot)&FileAttributes.ReparsePoint)!=0 ||
        (File.GetAttributes(Path.GetDirectoryName(file))&FileAttributes.ReparsePoint)!=0 ||
        (File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)
        throw new ArgumentException("reparse or absent receipt boundary");
      OwnFile(file,core);
      return;
    }
    if(args.Length!=4 || args[0]!="provision") throw new ArgumentException("fixture arguments");
    string root=Path.GetFullPath(args[1]);
    string dispatch=Path.GetFullPath(args[2]);
    IsolatedRoot(root);
    if(!String.Equals(Path.GetDirectoryName(dispatch),root,StringComparison.OrdinalIgnoreCase))
      throw new ArgumentException("dispatch must be directly under root");
    Guid dispatchId;
    if(Directory.Exists(root) || File.Exists(root) ||
      !Guid.TryParseExact(Path.GetFileName(dispatch),"D",out dispatchId))
      throw new ArgumentException("fresh isolated dispatch root required");
    var keeper=Sid(args[3]);
    var operatorSid=Sid("S-1-5-11");
    string control=Path.Combine(dispatch,"control");
    string keeperDir=Path.Combine(dispatch,"keeper");
    Directory.CreateDirectory(control);
    Directory.CreateDirectory(keeperDir);
    string bootstrap=Path.Combine(control,"bootstrap.json");
    File.WriteAllText(bootstrap,"{}");
    foreach(string path in new[]{root,dispatch,control,keeperDir}) OwnDirectory(path,core);
    OwnFile(bootstrap,core);
    // Exact initial root descriptor required by the production root validator.
    // This fixture does not alter the production helper or its security rule.
    var acl=new DirectorySecurity();
    acl.SetAccessRuleProtection(true,false);
    Add(acl,Sid("S-1-5-18"),FileSystemRights.FullControl,Both,PropagationFlags.None);
    Add(acl,operatorSid,FileSystemRights.FullControl,Both,PropagationFlags.None);
    Add(acl,core,FileSystemRights.ReadAndExecute|FileSystemRights.CreateDirectories,
      InheritanceFlags.None,PropagationFlags.None);
    Add(acl,core,FileSystemRights.FullControl,Both,PropagationFlags.InheritOnly);
    Add(acl,keeper,FileSystemRights.ReadAndExecute,InheritanceFlags.None,PropagationFlags.None);
    Add(acl,Sid("S-1-3-4"),FileSystemRights.ReadPermissions,
      InheritanceFlags.None,PropagationFlags.None);
    Directory.SetAccessControl(root,acl);
  }
}
