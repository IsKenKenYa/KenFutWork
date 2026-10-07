// 第一方Windows桌面原语；SDK声明依据Microsoft UIAutomation/User32文档。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

public static class KenDesktop {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder text,uint length,out uint needed);
  public static string ExpectedBinding;
  public static bool ActionSent;
  public static long ImageByteBudget;
  const uint KEYUP=2, UNICODE=4, LEFTDOWN=2, LEFTUP=4, RIGHTDOWN=8, RIGHTUP=16, MIDDLEDOWN=32, MIDDLEUP=64, WHEEL=0x800, HWHEEL=0x1000;
  const int WHEEL_DELTA=120;
  public class Window {
    public long windowId; public int pid; public string title,name,subrole,binding; public int[] bounds; public bool main,focused;
  }
  public class Node {
    public string role,title,value; public List<string> actions=new List<string>(),states=new List<string>(); public List<Node> children=new List<Node>();
  }
  public static void Initialize() {
    if (!Environment.UserInteractive) throw new Exception("permission_denied: 没有可交互Windows登录桌面");
    var desktop=OpenInputDesktop(0,false,0x0001|0x0080);
    if(desktop==IntPtr.Zero)throw new Exception("permission_denied: 当前输入桌面不可访问，可能处于安全桌面或其它登录会话");
    try {if(DesktopName(desktop)!=DesktopName(GetThreadDesktop(GetCurrentThreadId())))throw new Exception("permission_denied: 当前处于其它输入桌面，请用户返回正常桌面后重试");}finally{CloseDesktop(desktop);}
    try { if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)throw new Exception("unavailable: 无法建立Per-Monitor DPI v2坐标空间"); } catch (EntryPointNotFoundException) { throw new Exception("unavailable: 系统不支持Per-Monitor DPI v2"); }
  }
  static string DesktopName(IntPtr desktop) {
    uint needed;GetUserObjectInformation(desktop,2,null,0,out needed);
    if(needed==0)throw new Exception("permission_denied: 无法确认输入桌面身份");
    var text=new StringBuilder(checked((int)needed/2));
    if(!GetUserObjectInformation(desktop,2,text,needed,out needed))throw new Exception("permission_denied: 无法读取输入桌面身份");
    return text.ToString();
  }
  static string Text(IntPtr hwnd, bool className) {
    // Windows类名/标题API仅截取到接收buffer；按API请求的长度动态扩容。
    int size=256;
    while(true) { var b=new StringBuilder(size); int written=className?GetClassName(hwnd,b,size):GetWindowText(hwnd,b,size); if(written<size-1)return b.ToString(); size=checked(size*2); }
  }
  static Window Info(IntPtr hwnd) {
    if(!IsWindow(hwnd)) throw new Exception("app_not_found: 窗口已关闭");
    uint pid; GetWindowThreadProcessId(hwnd,out pid); RECT rect;
    if(!GetWindowRect(hwnd,out rect)) throw new Exception("permission_denied: 无法读取窗口几何");
    var process=Process.GetProcessById((int)pid);
    var w=new Window {windowId=hwnd.ToInt64(),pid=(int)pid,title=Text(hwnd,false),name=process.ProcessName,subrole=Text(hwnd,true),bounds=new[]{rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top},focused=GetForegroundWindow()==hwnd,main=process.MainWindowHandle==hwnd};
    w.binding=String.Join("/",w.windowId,w.pid,process.StartTime.ToUniversalTime().Ticks,w.subrole);
    return w;
  }
  public static Window[] Windows(int pid,string name) {
    var rows=new List<Window>();
    EnumWindows((hwnd,data)=> { if(IsWindowVisible(hwnd)) { try {var w=Info(hwnd);if((pid<=0||w.pid==pid)&&(String.IsNullOrEmpty(name)||w.name==name))rows.Add(w);}catch(InvalidOperationException){}catch(System.ComponentModel.Win32Exception){} } return true;},IntPtr.Zero);
    return rows.ToArray();
  }
  public static Window Select(int pid,string name,long windowId) {
    if(!String.IsNullOrEmpty(ExpectedBinding)) {
      var parts=ExpectedBinding.Split(new[]{'/'},4);long expectedId;
      if(parts.Length!=4||!Int64.TryParse(parts[0],out expectedId)||(windowId>0&&windowId!=expectedId))throw new Exception("element_stale: 原窗口绑定不再匹配");
      Window bound;try{bound=Info(new IntPtr(expectedId));}catch(Exception){throw new Exception("element_stale: 原窗口已关闭或无法确认身份");}
      if(bound.binding!=ExpectedBinding)throw new Exception("element_stale: 原窗口或进程已被替换");
      if((pid>0&&bound.pid!=pid)||(!String.IsNullOrEmpty(name)&&bound.name!=name))throw new Exception("app_owner_mismatch: 窗口不属于目标进程");
      return bound;
    }
    if(windowId>0) {var w=Info(new IntPtr(windowId));if((pid>0&&w.pid!=pid)||(!String.IsNullOrEmpty(name)&&w.name!=name))throw new Exception("app_owner_mismatch: 窗口不属于目标进程");return w;}
    var rows=Windows(pid,name);var active=rows.FirstOrDefault(w=>w.focused);if(active!=null)return active;if(rows.Length==0)throw new Exception("app_not_found: 目标应用无窗口");return rows[0];
  }
  public static object[] Apps() { return Windows(0,null).GroupBy(w=>w.pid).Select(g=>(object)new{pid=g.Key,name=g.First().name,bundleId=(string)null,active=g.Any(w=>w.focused)}).ToArray(); }
  public static object[] Displays() { return Screen.AllScreens.Select(s=>(object)new{id=s.DeviceName,name=s.DeviceName,bounds=new[]{s.Bounds.X,s.Bounds.Y,s.Bounds.Width,s.Bounds.Height},scaleFactor=1,primary=s.Primary}).ToArray(); }
  static Rectangle DisplayRect(string id) {var s=Screen.AllScreens.FirstOrDefault(x=>x.DeviceName==id);if(s==null)throw new Exception("display_not_found: 显示器已断开");return s.Bounds;}
  public static object Capture(int pid,string name,long windowId,string displayId) {
    Window w=String.IsNullOrEmpty(displayId)?Select(pid,name,windowId):null;
    var rect=w==null?DisplayRect(displayId):new Rectangle(w.bounds[0],w.bounds[1],w.bounds[2],w.bounds[3]);
    if(rect.Width<=0||rect.Height<=0)throw new Exception("unavailable: 窗口不可见或已最小化");
    if((long)rect.Width*rect.Height*4>ImageByteBudget)throw new Exception("image_budget_exceeded: 截图像素超过当前processMaxOutputBytes设置");
    using(var image=new Bitmap(rect.Width,rect.Height,PixelFormat.Format32bppArgb)) {
      using(var graphics=Graphics.FromImage(image)) graphics.CopyFromScreen(rect.Location,Point.Empty,rect.Size,CopyPixelOperation.SourceCopy);
      using(var stream=new MemoryStream()) {image.Save(stream,ImageFormat.Png);return new{width=image.Width,height=image.Height,base64=Convert.ToBase64String(stream.ToArray()),bounds=new[]{rect.X,rect.Y,rect.Width,rect.Height},binding=w==null?displayId:w.binding};}
    }
  }
  static Node Describe(AutomationElement element,int depth,int maxDepth,int maxChildren,int titleLimit,int valueLimit,int actionLimit,List<AutomationElement> flattened) {
    flattened.Add(element);
    var current=element.Current;var node=new Node{role=current.ControlType.ProgrammaticName.Replace("ControlType.","").ToLowerInvariant(),title=current.Name??""};
    if(node.role=="edit")node.role="textfield";
    if(node.title.Length>titleLimit)node.title=node.title.Substring(0,titleLimit);
    object pattern;
    if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {node.value=((ValuePattern)pattern).Current.Value??"";if(node.value.Length>valueLimit)node.value=node.value.Substring(0,valueLimit);node.states.Add("editable");}
    if(current.HasKeyboardFocus)node.states.Add("focused");if(!current.IsEnabled)node.states.Add("disabled");
    if(element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))node.actions.Add("invoke");
    if(element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))node.actions.Add("toggle");
    if(element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))node.actions.Add("select");
    if(node.actions.Count>actionLimit)node.actions=node.actions.Take(actionLimit).ToList();
    if(depth<maxDepth) {var child=TreeWalker.ControlViewWalker.GetFirstChild(element);for(int count=0;child!=null&&count<maxChildren;count++){node.children.Add(Describe(child,depth+1,maxDepth,maxChildren,titleLimit,valueLimit,actionLimit,flattened));child=TreeWalker.ControlViewWalker.GetNextSibling(child);}}
    return node;
  }
  public static object Observe(int pid,string name,long windowId,int maxDepth,int maxChildren,int titleLimit,int valueLimit,int actionLimit) {
    var w=Select(pid,name,windowId);var root=AutomationElement.FromHandle(new IntPtr(w.windowId));var nodes=new List<AutomationElement>();
    return new{app=new{pid=w.pid,name=w.name,bundleId=(string)null},window=new{windowId=w.windowId,title=w.title,bounds=w.bounds},root=Describe(root,0,maxDepth,maxChildren,titleLimit,valueLimit,actionLimit,nodes),binding=w.binding};
  }
  public static void Element(int pid,string name,long windowId,int index,string text,int maxDepth,int maxChildren,int titleLimit,int valueLimit,int actionLimit) {
    var w=Select(pid,name,windowId);var nodes=new List<AutomationElement>();Describe(AutomationElement.FromHandle(new IntPtr(w.windowId)),0,maxDepth,maxChildren,titleLimit,valueLimit,actionLimit,nodes);
    if(index<0||index>=nodes.Count)throw new Exception("element_stale: 元素已不在当前树中");var element=nodes[index];object pattern;
    if(text!=null){if(!element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))throw new Exception("element_unavailable: 目标不支持文本编辑");ActionSent=true;element.SetFocus();((ValuePattern)pattern).SetValue(text);return;}
    if(element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)){ActionSent=true;((InvokePattern)pattern).Invoke();return;}
    if(element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern)){ActionSent=true;((TogglePattern)pattern).Toggle();return;}
    if(element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)){ActionSent=true;((SelectionItemPattern)pattern).Select();return;}
    throw new Exception("element_unavailable: 目标没有可执行语义动作");
  }
  public static void Focus(int pid,string name,long windowId) {var w=Select(pid,name,windowId);if(!SetForegroundWindow(new IntPtr(w.windowId)))throw new Exception("foreground_required: Windows拒绝激活目标窗口，请用户激活后重试");ActionSent=true;}
  static void EnsureForeground() {if(!String.IsNullOrEmpty(ExpectedBinding)&&GetForegroundWindow().ToInt64()!=Select(0,null,0).windowId)throw new Exception("foreground_required: 目标已失去前台，请重新激活和观察");}
  static void Send(INPUT input,int delay) {bool releasing=input.type==1?(input.data.key.flags&KEYUP)!=0:(input.data.mouse.flags&(LEFTUP|RIGHTUP|MIDDLEUP))!=0;if(!releasing)EnsureForeground();if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("permission_denied: 输入被阻止，目标可能处于更高权限级或安全桌面");ActionSent=true;if(delay>0)Thread.Sleep(delay);}
  static void Mouse(uint flags,int data,int delay) {Send(new INPUT{type=0,data=new UNION{mouse=new MOUSEINPUT{flags=flags,data=unchecked((uint)data)}}},delay);}
  static void Key(ushort vk,ushort scan,uint flags,int delay) {Send(new INPUT{type=1,data=new UNION{key=new KEYBDINPUT{vk=vk,scan=scan,flags=flags}}},delay);}
  public static void Move(int x,int y) {EnsureForeground();if(!SetCursorPos(x,y))throw new Exception("permission_denied: 无法移动指针");ActionSent=true;}
  public static void Click(int x,int y,string button,int count,int delay) {Move(x,y);uint down=button=="right"?RIGHTDOWN:button=="middle"?MIDDLEDOWN:LEFTDOWN,up=button=="right"?RIGHTUP:button=="middle"?MIDDLEUP:LEFTUP;try{for(int i=0;i<count;i++){Mouse(down,0,delay);Mouse(up,0,delay);}}finally{Mouse(up,0,0);}}
  public static void Drag(int x,int y,int toX,int toY,int delay) {Move(x,y);try{Mouse(LEFTDOWN,0,delay);Move(toX,toY);if(delay>0)Thread.Sleep(delay);}finally{Mouse(LEFTUP,0,0);}}
  public static void Scroll(string direction,int amount,int delay) {bool horizontal=direction=="left"||direction=="right";int delta=(direction=="up"||direction=="right"?1:-1)*amount*WHEEL_DELTA;Mouse(horizontal?HWHEEL:WHEEL,delta,delay);}
  static ushort Code(string name) {string key=name.ToLowerInvariant();var keys=new Dictionary<string,ushort>{{"ctrl",17},{"control",17},{"shift",16},{"alt",18},{"option",18},{"meta",91},{"super",91},{"command",91},{"cmd",91},{"enter",13},{"return",13},{"tab",9},{"escape",27},{"esc",27},{"space",32},{"backspace",8},{"delete",46},{"left",37},{"right",39},{"up",38},{"down",40}};if(keys.ContainsKey(key))return keys[key];if(key.Length==1&&((key[0]>='a'&&key[0]<='z')||(key[0]>='0'&&key[0]<='9')))return (ushort)Char.ToUpperInvariant(key[0]);int f;if(key.StartsWith("f")&&Int32.TryParse(key.Substring(1),out f)&&f>=1&&f<=24)return (ushort)(111+f);throw new Exception("invalid_target: 不支持的按键"+name);}
  public static void Keys(string[] names,int delay,bool releaseOnly) {var keys=names.Select(Code).ToArray();if(releaseOnly){foreach(var key in keys.Reverse())Key(key,0,KEYUP,0);return;}var held=new List<ushort>();try{foreach(var key in keys){held.Add(key);Key(key,0,0,delay);}}finally{foreach(var key in held.AsEnumerable().Reverse())Key(key,0,KEYUP,delay);}}
  public static void Type(string text,int delay) {foreach(char value in text){Key(0,value,UNICODE,delay);Key(0,value,UNICODE|KEYUP,delay);}}
  public static void ReleaseMouse(){Mouse(LEFTUP,0,0);Mouse(RIGHTUP,0,0);Mouse(MIDDLEUP,0,0);}
}
