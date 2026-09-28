/* Deterministic Windows x64 PE test harness, no CRT, interpreter, network, or credentials.
 * Rebuild with clang --target=x86_64-pc-windows-msvc -Oz -ffreestanding
 * -fno-builtin -fno-stack-protector -c fake.c -o fake.obj, then link against
 * Kernel32 and Shell32 import libraries using lld-link /entry:mainCRTStartup
 * /subsystem:console /nodefaultlib /machine:x64 /timestamp:0.
 * All file effects are confined to the temporary repository cwd and run-dir
 * passed by the authoritative test adapter. Modes come from tracked bridge-mode.txt.
 */
typedef unsigned long DWORD;
typedef int BOOL;
typedef void *HANDLE;
typedef unsigned short WCHAR;
#define API __declspec(dllimport)
API HANDLE __stdcall GetStdHandle(DWORD);
API BOOL __stdcall ReadFile(HANDLE,void*,DWORD,DWORD*,void*);
API BOOL __stdcall WriteFile(HANDLE,const void*,DWORD,DWORD*,void*);
API HANDLE __stdcall CreateFileW(const WCHAR*,DWORD,DWORD,void*,DWORD,DWORD,HANDLE);
API BOOL __stdcall CloseHandle(HANDLE);
API WCHAR* __stdcall GetCommandLineW(void);
API WCHAR** __stdcall CommandLineToArgvW(const WCHAR*,int*);
API void* __stdcall LocalFree(void*);
API void __stdcall ExitProcess(DWORD);
API BOOL __stdcall CreateDirectoryW(const WCHAR*,void*);
static char input[65536], mode[128], head[128];
static WCHAR path[32768];
static DWORD len(const char *s){ DWORD n=0; while(s[n]) n++; return n; }
static int eq(const char*a,const char*b){while(*a && *a==*b){a++;b++;}return *a==*b;}
static int has(const char*s,const char*q){ for(;*s;s++){const char*a=s,*b=q;while(*b&&*a==*b){a++;b++;}if(!*b)return 1;}return 0; }
static DWORD readPath(const WCHAR*p,char*b,DWORD cap){
 HANDLE h=CreateFileW(p,0x80000000UL,7,0,3,0x80,0); DWORD n=0;
 if(h==(HANDLE)-1) return 0; ReadFile(h,b,cap-1,&n,0); CloseHandle(h); b[n]=0; return n;
}
static void writePath(const WCHAR*p,const char*s,DWORD n,int append){
 HANDLE h=CreateFileW(p,append?4:0x40000000UL,7,0,append?4:2,0x80,0); DWORD done=0;
 if(h==(HANDLE)-1) ExitProcess(91); if(!WriteFile(h,s,n,&done,0)||done!=n)ExitProcess(92); CloseHandle(h);
}
static void runPath(const WCHAR*dir,const WCHAR*name){unsigned i=0,j=0;while(dir[i]){if(i>32000)ExitProcess(93);path[i]=dir[i];i++;}path[i++]='\\';while(name[j])path[i++]=name[j++];path[i]=0;}
static void out(const char*s){DWORD n=0;WriteFile(GetStdHandle((DWORD)-11),s,len(s),&n,0);}
void mainCRTStartup(void){
 int argc=0; WCHAR **argv=CommandLineToArgvW(GetCommandLineW(),&argc); DWORD n=0,total=0;
 if(!argv||argc!=5)ExitProcess(80);
 while(total<sizeof(input)-1 && ReadFile(GetStdHandle((DWORD)-10),input+total,(DWORD)sizeof(input)-1-total,&n,0)&&n)total+=n;
 input[total]=0;
 if(total==0||!has(input,"\"protocol\":\"engineering-worker/1\"")||!has(input,"\"type\":\"IMPLEMENTATION\"")||!has(input,"\"role\":\"JUNIOR\""))ExitProcess(81);
 runPath(argv[2],(const WCHAR*)L"request.json");writePath(path,input,total,0);
 runPath(argv[2],(const WCHAR*)L"executions.txt");writePath(path,"executed\n",9,1);
 readPath((const WCHAR*)L"bridge-mode.txt",mode,sizeof(mode));
 if(eq(mode,"echo")){out(input);out("\n");ExitProcess(0);}
 if(eq(mode,"malformed")){out("{\"protocol\":\"engineering-worker/1\",\"outcome\":\"completed\"}\n");ExitProcess(0);}
 if(eq(mode,"edit"))writePath((const WCHAR*)L"README.md","native harness edit\n",20,0);
 if(eq(mode,"forbidden"))writePath((const WCHAR*)L"AGENTS.md","forbidden\n",10,0);
 if(eq(mode,"ignored")){CreateDirectoryW((const WCHAR*)L".cache",0);writePath((const WCHAR*)L".cache\\secret.txt","ignored mutation\n",17,0);}
 if(eq(mode,"head")){n=readPath((const WCHAR*)L"bridge-head.txt",head,sizeof(head));if(n!=40)ExitProcess(82);head[n++]='\n';writePath((const WCHAR*)L".git\\HEAD",head,n,0);}
 out("native harness progress\n");
 if(eq(mode,"blocked"))out("{\"protocol\":\"engineering-worker/1\",\"outcome\":\"blocked\",\"summary\":\"native requested block\",\"changed_files\":[],\"validation\":[],\"known_limitations\":[],\"blocked_reason\":\"deterministic block\",\"exit_code\":0}\n");
 else out("{\"protocol\":\"engineering-worker/1\",\"outcome\":\"completed\",\"summary\":\"native harness completed\",\"implementation_complete\":true,\"changed_files\":[],\"validation\":[{\"command\":\"fake validation\",\"status\":\"passed\"}],\"known_limitations\":[],\"exit_code\":0}\n");
 LocalFree(argv);ExitProcess(eq(mode,"process-failure")||eq(mode,"success7")?7:0);
}
