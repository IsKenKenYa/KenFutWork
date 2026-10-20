/**
 * 画布运行时：把设计文件渲染成**我们自己的文档**，并注入一块桥接脚本。
 *
 * 为什么不走上游预览 URL 直嵌：预览 iframe 是**不透明 origin**（sandbox 只给
 * `allow-scripts`），父页拿不到里面任何 DOM——评论锚点、标注对齐、可视化编辑
 * 全都需要命中测试。这里改成「宿主取正文 → 注入 → srcdoc 渲染」，桥接脚本跑在
 * 那一侧的不透明 origin 里，只通过 postMessage 与父页说话：
 *
 * - 设计代码拿不到本仓 origin（sandbox 不变，不给 `allow-same-origin`）；
 * - 相对资源靠注入的 `<base href=预览地址>` 落到上游；
 * - 正文是唯一的真相：编辑改的是**源文本**（见 openDesignSourceEdit.ts），
 *   渲染只是源文本的一次投影，因此不需要从实时 DOM 往回序列化。
 */

const INJECT_ATTRIBUTE = "data-kfw-od";

/** 桥接消息的 source 标记：父页据此过滤，别的窗口消息一律不吃。 */
export const OPEN_DESIGN_BRIDGE_SOURCE = "kfw-od";

/** 元素命中结果：路径是锚点与编辑共同的身份证。 */
export interface OpenDesignHit {
  path: string;
  tag: string;
  text: string;
  html: string;
  rect: { x: number; y: number; w: number; h: number };
  color: string;
  backgroundColor: string;
}

export interface OpenDesignRects {
  rects: Record<string, { x: number; y: number; w: number; h: number } | null>;
  /**
   * `w/h` 是文档全尺寸，`vw/vh` 是那一侧的视口尺寸，`sx/sy` 是滚动量。
   * 父层要靠这三组数换算：iframe 元素被 CSS zoom 与设备视口缩放过，
   * 只有拿「元素宽 ÷ 内侧视口宽」当比例，图钉与笔迹才贴得住内容而不是贴住屏幕。
   */
  doc: { h: number; sx: number; sy: number; vh: number; vw: number; w: number };
}

/** 父子两侧之间的全部消息（双向共用一个判别联合）。 */
export type BridgeMessage =
  | { source: typeof OPEN_DESIGN_BRIDGE_SOURCE; type: "pick"; on: boolean }
  | { source: typeof OPEN_DESIGN_BRIDGE_SOURCE; type: "hit"; id: number; x: number; y: number }
  | { source: typeof OPEN_DESIGN_BRIDGE_SOURCE; type: "track"; ids: string[] }
  | ({ source: typeof OPEN_DESIGN_BRIDGE_SOURCE; type: "ready" } & OpenDesignRects)
  | ({ source: typeof OPEN_DESIGN_BRIDGE_SOURCE; type: "rects" } & OpenDesignRects)
  | ({ source: typeof OPEN_DESIGN_BRIDGE_SOURCE; type: "hit"; id: number; hit: OpenDesignHit | null });

/**
 * 注入脚本正文（自包含 IIFE，不引用任何打包变量）。
 *
 * 命中测试用 `elementFromPoint`：坐标是 iframe 视口坐标，父页加自己的偏移即可。
 * 悬停高亮用一块覆盖层而不是改元素 style——改了就会污染「当前颜色」读数，
 * 甚至被当成用户的编辑写回文件。
 */
const BRIDGE_SCRIPT = `(function(){
  var SRC=${JSON.stringify(OPEN_DESIGN_BRIDGE_SOURCE)};
  var picking=false, trackIds=[], hover=null;
  function post(m){ m.source=SRC; parent.postMessage(m,"*"); }
  function layer(){
    if(hover) return hover;
    var d=document.createElement("div");
    d.setAttribute(${JSON.stringify(INJECT_ATTRIBUTE)},"hover");
    d.style.cssText="position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4f46e5;background:rgba(79,70,229,.12);border-radius:2px;display:none";
    (document.body||document.documentElement).appendChild(d);
    hover=d; return d;
  }
  function cssPath(el){
    if(!el||el.nodeType!==1) return "";
    if(el.id) return "#"+CSS.escape(el.id);
    var parts=[], node=el;
    while(node&&node.nodeType===1&&node.tagName!=="HTML"){
      var tag=node.tagName.toLowerCase(), sib=node, n=1, same=0, p=node.parentElement;
      if(p){
        var kids=Array.prototype.filter.call(p.children,function(c){return c.tagName===node.tagName && !c.hasAttribute(${JSON.stringify(INJECT_ATTRIBUTE)});});
        n=Math.max(1,kids.indexOf(node)+1);
        same=kids.length;
      }
      parts.unshift(tag+(same>1?":nth-of-type("+n+")":""));
      if(node.parentElement&&node.parentElement.tagName==="BODY"){ parts.unshift("body"); break; }
      node=node.parentElement;
    }
    return parts.join(" > ");
  }
  function resolve(path){
    if(!path) return null;
    try{ return /^#[\\w-]+$/.test(path)?document.getElementById(path.slice(1)):document.querySelector(path); }
    catch(e){ return null; }
  }
  function rectOf(el){ var r=el.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; }
  function describe(el){
    var cs=getComputedStyle(el), text=(el.innerText||el.textContent||"").replace(/\\s+/g," ").trim();
    return {path:cssPath(el),tag:el.tagName.toLowerCase(),text:text.slice(0,160),
      html:el.outerHTML.slice(0,20000),rect:rectOf(el),color:cs.color,backgroundColor:cs.backgroundColor};
  }
  function metrics(){
    var de=document.documentElement;
    return {
      w:Math.max(de.scrollWidth,de.clientWidth),
      h:Math.max(de.scrollHeight,de.clientHeight),
      vw:window.innerWidth, vh:window.innerHeight,
      sx:window.scrollX||de.scrollLeft, sy:window.scrollY||de.scrollTop
    };
  }
  function sendRects(type){
    var rects={};
    for(var i=0;i<trackIds.length;i++){ var el=resolve(trackIds[i]); rects[trackIds[i]]=el?rectOf(el):null; }
    post({type:type,rects:rects,doc:metrics()});
  }
  var queued=false;
  function queueRects(){
    if(!trackIds.length||queued) return;
    queued=true;
    requestAnimationFrame(function(){ queued=false; sendRects("rects"); });
  }
  document.addEventListener("click",function(ev){
    if(!picking) return;
    var el=ev.target;
    if(el&&el.hasAttribute&&el.hasAttribute(${JSON.stringify(INJECT_ATTRIBUTE)})) return;
    ev.preventDefault(); ev.stopPropagation();
    var hit=el&&el.nodeType===1?describe(el):null;
    post({type:"hit",id:-1,hit:hit});
    layer().style.display="none"; picking=false;
  },true);
  document.addEventListener("mousemove",function(ev){
    if(!picking) return;
    var el=document.elementFromPoint(ev.clientX,ev.clientY);
    if(!el||el.nodeType!==1||el.hasAttribute(${JSON.stringify(INJECT_ATTRIBUTE)})){ layer().style.display="none"; return; }
    var r=rectOf(el), d=layer();
    d.style.left=r.x+"px"; d.style.top=r.y+"px"; d.style.width=r.w+"px"; d.style.height=r.h+"px"; d.style.display="block";
  },true);
  window.addEventListener("scroll",queueRects,true);
  window.addEventListener("resize",function(){ queueRects(); });
  window.addEventListener("message",function(ev){
    var d=ev.data; if(!d||d.source!==SRC) return;
    if(d.type==="pick"){
      picking=!!d.on;
      document.documentElement.style.cursor=picking?"crosshair":"";
      if(!picking) layer().style.display="none";
      return;
    }
    if(d.type==="hit"){
      var el=document.elementFromPoint(d.x,d.y);
      post({type:"hit",id:d.id,hit:el&&el.nodeType===1?describe(el):null});
      return;
    }
    if(d.type==="track"){ trackIds=Array.isArray(d.ids)?d.ids:[]; sendRects("rects"); }
  });
  function boot(){ post({type:"ready",rects:{},doc:metrics()}); }
  if(document.readyState==="complete") boot();
  else window.addEventListener("load",boot);
})();`;

/** 注入用的两个标记：`<base>` 与桥脚本，都带 `data-kfw-od` 便于识别。 */
export function buildCanvasDocument(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // 先清掉上一轮的注入件（base 在 head、桥在 body），否则重挂一次就多一份脚本。
  doc
    .querySelectorAll(`[${INJECT_ATTRIBUTE}]`)
    .forEach((node) => node.remove());
  const base = doc.createElement("base");
  base.setAttribute(INJECT_ATTRIBUTE, "base");
  base.href = baseUrl;
  doc.head?.prepend(base);
  const script = doc.createElement("script");
  script.setAttribute(INJECT_ATTRIBUTE, "bridge");
  script.textContent = BRIDGE_SCRIPT;
  doc.body?.appendChild(script);
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/** 桥脚本正文（测试与面板共用；面板只把它交给 buildCanvasDocument）。 */
export const OPEN_DESIGN_BRIDGE_SOURCE_TEXT = BRIDGE_SCRIPT;
