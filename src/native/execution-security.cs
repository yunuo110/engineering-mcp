// Fixed, staged Windows ACL boundary for the protected Core/Keeper path.
// No shell, PowerShell, credential, network or production configuration access.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

internal static class ExecutionSecurity {
  const string Build = "engineering-execution-security/1";
  static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
  static readonly SecurityIdentifier OwnerRightsSid = new SecurityIdentifier("S-1-3-4");
  static readonly InheritanceFlags Both = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
  static readonly AccessControlSections ReadSections =
    AccessControlSections.Access | AccessControlSections.Owner | AccessControlSections.Group;

  static string Required(Dictionary<string,object> value,string key) {
    object raw;
    if(!value.TryGetValue(key,out raw) || !(raw is string) || String.IsNullOrEmpty((string)raw))
      throw new InvalidDataException("invalid field " + key);
    return (string)raw;
  }
  static bool IsFile(string path) { return File.Exists(path) && !Directory.Exists(path); }
  static FileSystemSecurity Security(string path) {
    if(Directory.Exists(path)) return Directory.GetAccessControl(path,ReadSections);
    if(IsFile(path)) return File.GetAccessControl(path,ReadSections);
    throw new FileNotFoundException("ACL target absent");
  }
  static object SnapshotRow(string path) {
    path=Path.GetFullPath(path);
    var acl=Security(path);
    var aces=new List<object>();
    foreach(AuthorizationRule raw in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
      var ace=raw as FileSystemAccessRule;
      if(ace==null) throw new InvalidDataException("non-filesystem ACE");
      aces.Add(new {
        sid=((SecurityIdentifier)ace.IdentityReference).Value,
        rights=(int)ace.FileSystemRights,
        inherited=ace.IsInherited,
        type=ace.AccessControlType.ToString(),
        inheritOnly=(ace.PropagationFlags & PropagationFlags.InheritOnly)!=0,
        containerInherit=(ace.InheritanceFlags & InheritanceFlags.ContainerInherit)!=0,
        objectInherit=(ace.InheritanceFlags & InheritanceFlags.ObjectInherit)!=0
      });
    }
    return new {
      path=path,
      owner=((SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier))).Value,
      @protected=acl.AreAccessRulesProtected,
      reparse=(File.GetAttributes(path) & FileAttributes.ReparsePoint)!=0,
      sddl=acl.GetSecurityDescriptorSddlForm(ReadSections),
      aces=aces.ToArray()
    };
  }
  static void Snapshot(string input,JavaScriptSerializer json) {
    var paths=json.Deserialize<List<string>>(input);
    if(paths==null || paths.Count<1 || paths.Count>4096) throw new InvalidDataException("path count");
    var rows=new List<object>();
    foreach(string path in paths) {
      if(String.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) throw new InvalidDataException("absolute path required");
      rows.Add(SnapshotRow(path));
    }
    var installer=(SecurityIdentifier)new NTAccount("NT SERVICE","TrustedInstaller").Translate(typeof(SecurityIdentifier));
    Console.Out.Write(json.Serialize(new {
      sid=WindowsIdentity.GetCurrent().User.Value,
      trustedInstallerSid=installer.Value,
      rows=rows.ToArray()
    }));
  }
  static void NoReparse(string path) {
    for(string current=Path.GetFullPath(path); current!=null;) {
      if(!File.Exists(current) && !Directory.Exists(current)) throw new FileNotFoundException("witness path absent");
      if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)
        throw new InvalidDataException("witness reparse boundary");
      string parent=Path.GetDirectoryName(current);
      if(parent==null || parent==current) break;
      current=parent;
    }
  }
  static void Add(DirectorySecurity acl,SecurityIdentifier sid,FileSystemRights rights,
    InheritanceFlags inheritance,PropagationFlags propagation) {
    acl.AddAccessRule(new FileSystemAccessRule(sid,rights,inheritance,propagation,AccessControlType.Allow));
  }
  static void SetDirectory(string path,string kind,SecurityIdentifier core,SecurityIdentifier keeper,
    SecurityIdentifier operatorSid) {
    NoReparse(path);
    var current=Directory.GetAccessControl(path,AccessControlSections.Owner);
    if(!((SecurityIdentifier)current.GetOwner(typeof(SecurityIdentifier))).Equals(core))
      throw new InvalidDataException("Core must own witness directory before ACL seal");
    var acl=new DirectorySecurity();
    acl.SetAccessRuleProtection(true,false);
    Add(acl,SystemSid,FileSystemRights.FullControl,Both,PropagationFlags.None);
    Add(acl,operatorSid,FileSystemRights.FullControl,Both,PropagationFlags.None);
    if(kind=="root") {
      Add(acl,core,FileSystemRights.ReadAndExecute|FileSystemRights.CreateDirectories,
        InheritanceFlags.None,PropagationFlags.None);
      Add(acl,core,FileSystemRights.FullControl,Both,PropagationFlags.InheritOnly);
      Add(acl,keeper,FileSystemRights.ReadAndExecute,InheritanceFlags.None,PropagationFlags.None);
      Add(acl,OwnerRightsSid,FileSystemRights.ReadPermissions,InheritanceFlags.None,PropagationFlags.None);
    } else {
      Add(acl,core,kind=="control"?FileSystemRights.Modify:FileSystemRights.ReadAndExecute,
        Both,PropagationFlags.None);
      Add(acl,keeper,kind=="keeper"?FileSystemRights.Modify:FileSystemRights.ReadAndExecute,
        Both,PropagationFlags.None);
      Add(acl,OwnerRightsSid,FileSystemRights.ReadPermissions,Both,PropagationFlags.None);
    }
    Directory.SetAccessControl(path,acl);
  }
  static void Check(string path,string kind,bool file,string core,string keeper,string operatorSid) {
    NoReparse(path);
    var acl=Security(path);
    string owner=((SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier))).Value;
    string expected=file && kind=="keeper"?keeper:core;
    if(owner!=expected || (!file && !acl.AreAccessRulesProtected))
      throw new InvalidDataException("witness owner/inheritance mismatch");
    bool seenCore=false,seenKeeper=false,seenOwner=false;
    foreach(AuthorizationRule raw in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
      var ace=raw as FileSystemAccessRule;
      if(ace==null || ace.AccessControlType!=AccessControlType.Allow)
        throw new InvalidDataException("unexpected witness ACE");
      string sid=((SecurityIdentifier)ace.IdentityReference).Value;
      int rights=(int)ace.FileSystemRights;
      bool inheritOnly=(ace.PropagationFlags&PropagationFlags.InheritOnly)!=0;
      if(sid==operatorSid || sid==SystemSid.Value) continue;
      if(sid==OwnerRightsSid.Value) {
        if((rights & ~1179648)!=0) throw new InvalidDataException("owner WRITE_DAC not suppressed");
        if(!inheritOnly && (rights & 131072)!=0) seenOwner=true;
        continue;
      }
      if(sid==core) {
        int limit=kind=="control"?1245631:1179817;
        if(kind=="root") {
          if(inheritOnly) {
            if(rights!=2032127) throw new InvalidDataException("root child provisioning ACE");
            continue;
          }
          limit=1179821;
        }
        if((rights & ~limit)!=0) throw new InvalidDataException("Core witness access mismatch");
        if((rights & 1)!=0 && !inheritOnly) seenCore=true;
        continue;
      }
      if(sid==keeper) {
        int limit=kind=="keeper"?1245631:1179817;
        if((rights & ~limit)!=0) throw new InvalidDataException("Keeper witness access mismatch");
        if((rights & 1)!=0 && !inheritOnly) seenKeeper=true;
        continue;
      }
      throw new InvalidDataException("untrusted witness ACE");
    }
    if(!seenCore || !seenKeeper || !seenOwner) throw new InvalidDataException("incomplete witness ACL");
  }
  static void Witness(string input,JavaScriptSerializer json) {
    var req=json.Deserialize<Dictionary<string,object>>(input);
    if(req==null) throw new InvalidDataException("witness request");
    string operation=Required(req,"operation"),root=Path.GetFullPath(Required(req,"root"));
    string dispatch=Path.GetFullPath(Required(req,"dispatch"));
    string core=Required(req,"core"),keeper=Required(req,"keeper"),operatorValue=Required(req,"operator");
    if(core==keeper || core==operatorValue || keeper==operatorValue ||
      WindowsIdentity.GetCurrent().User.Value!=core ||
      !String.Equals(Path.GetDirectoryName(dispatch),root,StringComparison.OrdinalIgnoreCase))
      throw new InvalidDataException("Core witness identity/path required");
    var coreSid=new SecurityIdentifier(core);
    var keeperSid=new SecurityIdentifier(keeper);
    var operatorSid=new SecurityIdentifier(operatorValue);
    if(operation=="root") {
      if(!Directory.Exists(root)) {
        Directory.CreateDirectory(root);
        SetDirectory(root,"root",coreSid,keeperSid,operatorSid);
      }
      Check(root,"root",false,core,keeper,operatorValue);
    } else if(operation=="seal") {
      Check(root,"root",false,core,keeper,operatorValue);
      SetDirectory(Path.Combine(dispatch,"control"),"control",coreSid,keeperSid,operatorSid);
      SetDirectory(Path.Combine(dispatch,"keeper"),"keeper",coreSid,keeperSid,operatorSid);
      SetDirectory(dispatch,"dispatch",coreSid,keeperSid,operatorSid);
      Check(dispatch,"dispatch",false,core,keeper,operatorValue);
      Check(Path.Combine(dispatch,"control"),"control",false,core,keeper,operatorValue);
      Check(Path.Combine(dispatch,"keeper"),"keeper",false,core,keeper,operatorValue);
      Check(Path.Combine(dispatch,"control","bootstrap.json"),"control",true,core,keeper,operatorValue);
    } else if(operation=="read") {
      Check(root,"root",false,core,keeper,operatorValue);
      Check(dispatch,"dispatch",false,core,keeper,operatorValue);
      Check(Path.Combine(dispatch,"control"),"control",false,core,keeper,operatorValue);
      Check(Path.Combine(dispatch,"keeper"),"keeper",false,core,keeper,operatorValue);
      foreach(string name in new[]{"bootstrap.json","validation.json"}) {
        string path=Path.Combine(dispatch,"control",name);
        if(File.Exists(path)) Check(path,"control",true,core,keeper,operatorValue);
      }
      foreach(string name in new[]{"runtime.sealed.json","runtime.resumed.json","drain-receipt.json"}) {
        string path=Path.Combine(dispatch,"keeper",name);
        if(File.Exists(path)) Check(path,"keeper",true,core,keeper,operatorValue);
      }
    } else throw new InvalidDataException("witness operation");
    Console.Out.Write("WITNESS_SECURITY_OK");
  }
  static int Main(string[] args) {
    try {
      if(args.Length==1 && args[0]=="--version") {Console.Out.Write(Build);return 0;}
      if(args.Length!=1 || (args[0]!="snapshot" && args[0]!="witness"))
        throw new InvalidDataException("fixed operation required");
      Console.InputEncoding=new UTF8Encoding(false);
      Console.OutputEncoding=new UTF8Encoding(false);
      string input=Console.In.ReadToEnd();
      if(input.Length>0 && input[0]=='\uFEFF') input=input.Substring(1);
      if(input.Length==0 || input.Length>4*1024*1024) throw new InvalidDataException("request bound");
      var json=new JavaScriptSerializer {MaxJsonLength=8*1024*1024};
      if(args[0]=="snapshot") Snapshot(input,json); else Witness(input,json);
      return 0;
    } catch(Exception error) {
      Console.Error.WriteLine("EXECUTION_SECURITY_REFUSED:"+error.GetType().Name+":"+error.Message);
      return 86;
    }
  }
}
