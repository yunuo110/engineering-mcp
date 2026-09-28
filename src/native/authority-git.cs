// Authority-only Git gateway. Repository configuration is data, never code.
// Windows locks retain the checked config and its ancestors until Git exits.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class AuthorityGit {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);
  static readonly HashSet<string> Commands = new HashSet<string>(StringComparer.Ordinal) {
    "rev-parse", "status", "diff-tree", "ls-tree", "read-tree", "add", "diff-files",
    "write-tree", "symbolic-ref", "commit-tree", "update-ref", "rev-list", "log", "ls-files"
  };
  static readonly HashSet<string> ConfigKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates",
    "core.ignorecase", "core.precomposeunicode", "core.symlinks", "core.autocrlf",
    "core.safecrlf", "core.eol", "user.name", "user.email", "init.defaultbranch", "commit.gpgsign"
  };
  static readonly HashSet<string> ExtraEnvironment = new HashSet<string>(StringComparer.Ordinal) {
    "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
    "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"
  };
  static string Quote(string s) {
    if (s.IndexOf('\0') >= 0) throw new InvalidDataException("NUL argument");
    var b=new StringBuilder("\""); int n=0;
    foreach(char c in s) { if(c=='\\') { n++; continue; }
      b.Append('\\', c=='\"' ? n*2+1 : n); b.Append(c); n=0; }
    b.Append('\\',n*2); return b.Append('"').ToString();
  }
  static void LockPath(string path, bool directory, List<IDisposable> locks, HashSet<string> seen) {
    path=Path.GetFullPath(path);
    if(!seen.Add(path)) return;
    string parent=Path.GetDirectoryName(path);
    if(parent!=null && parent!=path) LockPath(parent,true,locks,seen);
    // Deny directory replacement, and deny config modification AND replacement.
    var handle=CreateFile(path,directory ? 0x80u : 0x80000000u,directory ? 3u : 1u,
      IntPtr.Zero,3,0x00200000u | (directory ? 0x02000000u : 0u),IntPtr.Zero);
    if(handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(),"config boundary lock"); }
    locks.Add(handle);
    if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)
      throw new InvalidDataException("reparse Git metadata refused");
  }
  static string FindRoot(string cwd) {
    for(var d=new DirectoryInfo(Path.GetFullPath(cwd)); d!=null; d=d.Parent)
      if(Directory.Exists(Path.Combine(d.FullName,".git")) || File.Exists(Path.Combine(d.FullName,".git"))) return d.FullName;
    throw new InvalidDataException("not a git repository");
  }
  static ProcessStartInfo StartInfo(string git,string cwd,IEnumerable<string> args,Dictionary<string,string> env) {
    var words=new List<string>(); foreach(string a in args) words.Add(Quote(a));
    var si=new ProcessStartInfo(git,String.Join(" ",words.ToArray())) {
      WorkingDirectory=cwd, UseShellExecute=false, CreateNoWindow=true,
      RedirectStandardOutput=true, RedirectStandardError=true, RedirectStandardInput=true,
      StandardOutputEncoding=new UTF8Encoding(false), StandardErrorEncoding=new UTF8Encoding(false)
    };
    si.EnvironmentVariables.Clear(); foreach(var pair in env) si.EnvironmentVariables[pair.Key]=pair.Value;
    return si;
  }
  static int Run(ProcessStartInfo si,out string output,out string error) {
    using(var p=Process.Start(si)) {
      p.StandardInput.Close(); var outTask=p.StandardOutput.ReadToEndAsync(); var errTask=p.StandardError.ReadToEndAsync();
      if(!p.WaitForExit(30000)) { p.Kill(); p.WaitForExit(); throw new IOException("Git operation timeout"); }
      output=outTask.Result; error=errTask.Result; return p.ExitCode;
    }
  }
  static int Main() {
    var locks=new List<IDisposable>(); var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    try {
      Console.InputEncoding=new UTF8Encoding(false);
      Console.OutputEncoding=new UTF8Encoding(false);
      var json=new JavaScriptSerializer { MaxJsonLength=1048576 };
      string input=Console.In.ReadToEnd(); if(input.Length>1048576) throw new InvalidDataException("request bound");
      var req=json.Deserialize<Dictionary<string,object>>(input);
      string git=(string)req["git"], cwd=Path.GetFullPath((string)req["repo"]);
      if(!Path.IsPathRooted(git) || !File.Exists(git)) throw new InvalidDataException("absolute Git required");
      var args=new List<string>(); foreach(object a in (System.Collections.IEnumerable)req["args"]) args.Add((string)a);
      if(args.Count==0 || !Commands.Contains(args[0])) throw new InvalidDataException("authority command refused");
      string root=FindRoot(cwd); LockPath(root,true,locks,seen);
      string dot=Path.Combine(root,".git"), gitDir=dot;
      if(File.Exists(dot)) {
        LockPath(dot,false,locks,seen); string pointer=File.ReadAllText(dot).Trim();
        if(!pointer.StartsWith("gitdir: ",StringComparison.Ordinal) || pointer.IndexOf('\n')>=0)
          throw new InvalidDataException("invalid gitdir pointer");
        gitDir=Path.GetFullPath(Path.Combine(root,pointer.Substring(8)));
      }
      LockPath(gitDir,true,locks,seen);
      string common=gitDir, commonFile=Path.Combine(gitDir,"commondir");
      if(File.Exists(commonFile)) {
        LockPath(commonFile,false,locks,seen); string pointer=File.ReadAllText(commonFile).Trim();
        if(pointer.Length==0 || pointer.IndexOf('\n')>=0) throw new InvalidDataException("invalid commondir");
        common=Path.GetFullPath(Path.Combine(gitDir,pointer)); LockPath(common,true,locks,seen);
      }
      string config=Path.Combine(common,"config"); LockPath(config,false,locks,seen);
      if(new FileInfo(config).Length>1048576) throw new InvalidDataException("config bound");
      // Worktree config cannot appear later: extensions.worktreeConfig is not in the positive schema.
      var env=new Dictionary<string,string>(StringComparer.Ordinal) {
        {"SystemRoot",Environment.GetEnvironmentVariable("SystemRoot") ?? "C:\\Windows"},
        {"PATH",Path.GetDirectoryName(git)+";C:\\Windows\\System32"},
        {"GIT_CONFIG_NOSYSTEM","1"}, {"GIT_CONFIG_SYSTEM","NUL"}, {"GIT_CONFIG_GLOBAL","NUL"},
        {"GIT_TERMINAL_PROMPT","0"}, {"GIT_NO_LAZY_FETCH","1"}, {"GIT_NO_REPLACE_OBJECTS","1"},
        {"GIT_DIR",gitDir}, {"GIT_COMMON_DIR",common}, {"GIT_WORK_TREE",root}, {"GIT_ATTR_NOSYSTEM","1"}
      };
      if(req.ContainsKey("env")) foreach(var pair in (Dictionary<string,object>)req["env"]) {
        if(!ExtraEnvironment.Contains(pair.Key) || !(pair.Value is string)) throw new InvalidDataException("environment key refused");
        env[pair.Key]=(string)pair.Value;
      }
      string output,error;
      int code=Run(StartInfo(git,cwd,new[]{"--no-pager","config","--file",config,"--no-includes","--null","--list"},env),out output,out error);
      if(code!=0) throw new InvalidDataException("config parse refused");
      foreach(string item in output.Split('\0')) {
        if(item.Length==0) continue; int split=item.IndexOf('\n');
        string key=split<0?item:item.Substring(0,split), value=split<0?"":item.Substring(split+1);
        bool passive=Regex.IsMatch(key,@"^(remote\.[^.]+\.(url|fetch)|branch\.[^.]+\.(remote|merge))$",RegexOptions.CultureInvariant);
        if(!ConfigKeys.Contains(key) && !passive) throw new InvalidDataException("repository configuration is outside authority schema: "+key);
        if(key.Equals("core.repositoryformatversion",StringComparison.OrdinalIgnoreCase) && value!="0") throw new InvalidDataException("repository format refused");
        if(key.Equals("commit.gpgsign",StringComparison.OrdinalIgnoreCase) && value!="false") throw new InvalidDataException("repository signing refused");
      }
      var command=new List<string>{"--no-pager","-c","core.hooksPath=NUL","-c","core.fsmonitor=false",
        "-c","core.attributesFile=NUL","-c","diff.external=","-c","commit.gpgSign=false","-c","submodule.recurse=false",
        "-c","safe.directory="+root};
      // A submodule has a second, independently writable configuration. Until
      // that configuration has an equivalent locked gateway, refuse gitlinks
      // rather than delegating a Core-token status process into it. The guard
      // command reads index entries only and never recurses into a worktree.
      var inventory=new List<string>(command);
      inventory.AddRange(new[]{"ls-files","--stage","-z"});
      code=Run(StartInfo(git,cwd,inventory,env),out output,out error);
      if(code!=0) throw new InvalidDataException("index inventory refused");
      foreach(string entry in output.Split('\0'))
        if(entry.StartsWith("160000 ",StringComparison.Ordinal))
          throw new InvalidDataException("submodule authority configuration unsupported");
      // Do not allow an index changed concurrently after inventory to start a
      // nested status process either. This does not establish submodule support.
      if(args[0]=="status" || args[0]=="diff-files" || args[0]=="diff-tree") {
        args.RemoveAll(a=>a.StartsWith("--ignore-submodules",StringComparison.Ordinal));
        args.Insert(1,"--ignore-submodules=all");
      }
      command.AddRange(args);
      code=Run(StartInfo(git,cwd,command,env),out output,out error);
      Console.Out.Write(output); Console.Error.Write(error); return code;
    } catch(Exception e) { Console.Error.WriteLine("AUTHORITY_GIT_REFUSED:"+e.Message); return 86; }
    finally { for(int i=locks.Count-1;i>=0;i--) locks[i].Dispose(); }
  }
}
