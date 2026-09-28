// TEST FIXTURE - SANITIZED - NOT PRODUCTION EVIDENCE.
using System;
using System.Diagnostics;
using System.IO.Pipes;
using System.Threading.Tasks;
using System.Threading;
using System.IO;

namespace EngineeringIngress {
public static class BrokerMain {
    public static int Main(string[] args){
        if(args.Length!=0){Console.Error.WriteLine("{\"status\":\"HOLD\",\"code\":\"NO_ARGUMENTS_ALLOWED\"}");return 2;}
        try{WindowsBoundary.RequireSid(Bindings.ControllerSid);WindowsBoundary.EnterLifetimeJob();Run().GetAwaiter().GetResult();return 0;}
        catch(Exception e){Log("HOLD",e is GateException?((GateException)e).Code:"BROKER_FAILURE",null,null);return 2;}
    }
    static void Log(string status,string code,McpChild child,object ids){
        var text=Json.Dump(Json.D("timestamp",DateTime.UtcNow.ToString("o"),"status",status,"code",code,"broker_pid",Process.GetCurrentProcess().Id,"child_pid",child==null?(object)null:child.Pid,"request",ids));
        Console.Error.WriteLine(text);
        // Only the private ingress runtime log. Errors are fixed codes, never upstream exception text.
        try{
            if(WindowsBoundary.Sid()!=Bindings.ControllerSid)return;
            ReleaseGuard.PlainPath(Bindings.RuntimeDirectory);var path=Path.Combine(Bindings.RuntimeDirectory,"broker-log.jsonl");
            if(File.Exists(path)){ReleaseGuard.PlainPath(path);if(new FileInfo(path).Length>1024*1024)File.Delete(path);}
            File.AppendAllText(path,text+"\n",Json.Utf8);
        }catch{} // Logging failure never grants execution or accesses an alternate directory.
    }
    static async Task WatchStop(CancellationTokenSource signal){
        // Admin-controlled file; this is not an external broker operation or request-timeout path.
        var path=Path.Combine(Path.GetDirectoryName(Bindings.RuntimeDirectory),"stop.request");
        while(!signal.IsCancellationRequested){
            if(File.Exists(path)){ReleaseGuard.PlainPath(path);if(new FileInfo(path).Length>16)throw new GateException("STOP_CONTROL_SIZE");if(File.ReadAllText(path).Trim()=="STOP"){signal.Cancel();return;}}
            await Task.Delay(250);
        }
    }
    static async Task<McpChild> Start(){
        var preflight=Task.Run(()=>ReleaseGuard.Preflight());
        if(await Task.WhenAny(preflight,Task.Delay(120000))!=preflight)throw new GateException("STARTUP_PREFLIGHT_TIMEOUT");
        await preflight;var child=new McpChild();
        try{await child.Start(ReleaseGuard.StartInfo(Bindings.Node,ReleaseGuard.ChildArgs(),Bindings.Repo),Bindings.ControllerSid,15000);
            for(int n=0;n<200 && !child.StartupRecordSeen;n++)await Task.Delay(10);
            if(!child.StartupRecordSeen)throw new GateException("CONTROLLER_STARTUP_RECORD_MISSING");
            WriteStartupProof(child);
            Log("READY","CHILD_INITIALIZED",child,null);return child;
        }catch{child.Dispose();throw;}
    }
    static void WriteStartupProof(McpChild child){
        var proof=Json.D("schema","engineering-ingress-startup/1","timestamp",DateTime.UtcNow.ToString("o"),
            "broker_pid",Process.GetCurrentProcess().Id,"broker_sid",WindowsBoundary.Sid(),
            "child_pid",child.Pid,"child_sid",child.ActualSid,"repo",Bindings.Repo,"db",Bindings.Db,
            "foundation",Bindings.Foundation,"foundation_manifest",Bindings.FoundationManifest,
            "ingress_release",Bindings.IngressRoot,"controller_tools",child.Tools,"frozen_startup_record_observed",true);
        var path=System.IO.Path.Combine(Bindings.RuntimeDirectory,"startup-proof.json");
        if(System.IO.File.Exists(path))ReleaseGuard.PlainPath(path);
        System.IO.File.WriteAllText(path,Json.Dump(proof),Json.Utf8);
    }
    static async Task Run(){
        // A single server instance retains the first-instance-protected name across connections.
        using(var pipe=WindowsBoundary.Server(Bindings.Pipe,Bindings.ControllerSid,Bindings.BridgeSid))
        using(var stopping=new CancellationTokenSource()){
            McpChild child=null;int starts=0;DateTime window=DateTime.UtcNow;
            try{
                child=await Start();starts++;var watcher=WatchStop(stopping);
                while(!stopping.IsCancellationRequested){
                    if(watcher.IsFaulted)throw new GateException("STOP_CONTROL_FAILURE");
                    try{var connect=pipe.WaitForConnectionAsync(stopping.Token);
                        if(await Task.WhenAny(connect,watcher)==watcher){await watcher;break;}await connect;
                    }catch(OperationCanceledException){break;}
                    try{
                        byte[] bytes=await WindowsBoundary.BoundedIo(Frame.Read(pipe),pipe,5000);
                        WindowsBoundary.AuthenticatePeer(pipe,Bindings.BridgeSid);WindowsBoundary.RejectBufferedTrailing(pipe);
                        var request=Wire.Request(bytes);var plan=Json.Obj(request["plan_message"]);
                        var ids=Json.D("message_id",plan["message_id"],"task_id",plan["task_id"],"acceptance_command_id",request["acceptance_command_id"],"delegation_command_id",request["delegation_command_id"],"worker_profile_id",request["worker_profile_id"]);
                        if(!child.Alive){
                            if(!child.Exited)throw new GateException("CHILD_PROTOCOL_HOLD_NO_AUTORESTART");
                            // Restart a dead transport only; never replay its prior request or modify Engineering task state.
                            if(DateTime.UtcNow-window>TimeSpan.FromMinutes(10)){starts=0;window=DateTime.UtcNow;}
                            if(starts>=3)throw new GateException("CHILD_RESTART_BUDGET");
                            child.Dispose();child=null;child=await Start();starts++;
                        }
                        var timer=Stopwatch.StartNew();object reply=await child.Execute(request,30000);
                        var packet=Frame.Encode(Json.Bytes(reply));
                        await WindowsBoundary.BoundedIo(pipe.WriteAsync(packet,0,packet.Length),pipe,5000);
                        // No request payload, tool output, environment, or upstream stderr is logged.
                        Log((string)Json.Obj(reply)["status"],"CALL_RETURNED_"+timer.ElapsedMilliseconds,child,ids);
                    }catch(GateException e){
                        // Authentication failures receive no application response. Other failures also close the connection.
                        Log("CONNECTION_CLOSED",e.Code,child,null);
                    }catch{Log("CONNECTION_CLOSED","IPC_FAILURE",child,null);}
                    finally{if(pipe.IsConnected)pipe.Disconnect();}
                }
            }finally{stopping.Cancel();if(child!=null)child.Dispose();}
        }
    }
}
}
