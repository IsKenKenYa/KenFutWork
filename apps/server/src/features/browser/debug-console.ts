import { CdpError } from "./cdp-client.js";

/**
 * 「打开调试工具」注入的**页面内调试控制台**（Eruda）脚本来源。
 *
 * 为什么由服务端取脚本、**把源码整段注入**（而不是往页面里插一个 `<script src=…>`）：
 * - 页面里插 script 标签把成败交给了那个页面的网络与策略（CSP、外部脚本拦截、加载顺序），
 *   真机上就撞到过——注入报成功、页面上什么都没有（用户在面板里看到「点了没反应」）；
 * - 源码直投走 `Runtime.evaluate`，是**运行代码**而不是新增资源请求，上面那一类失败不存在；
 * - 顺带把 CDN 依赖收在服务端一处（页面不必联网到 CDN），也便于自检「到底生效没有」。
 *
 * 脚本在服务端缓存（几百 KB，一次取；失败不缓存，下次还能重试）。两端共用同一份源码：
 * - Web / 自托管形态：CDP `Runtime.evaluate` 注入到受控页面；
 * - 桌面外壳：`GET /api/browser/debug-console.js` 取同一份源码，`eval` 进面板里的子 WebView2。
 */

/** 脚本来源（钉住版本；要换源或自托管镜像只改这一处）。 */
export const DEBUG_CONSOLE_SCRIPT_URL =
  "https://cdn.jsdelivr.net/npm/eruda@3.4.1/eruda.min.js";

/**
 * 源码之后要接的启动尾巴：初始化 + 显示。
 *
 * 幂等——重复点「打开调试工具」只是把已经加载的控制台再显示一次，不会叠出第二个。
 * 出错时把原因写到 `window.__kfwDebugConsoleError`：页面里的异常浏览器控制台才看得到，
 * 服务端只能靠这个自报（否则又是「点了没反应」那种哑失败）。
 *
 * 形态：用户口径「内嵌的控制台做成悬浮窗，可以拖动、可以关闭」——Eruda 默认是贴页面底部的
 * 抽屉，所以注入后再加一步 `FLOAT_SCRIPT`：把容器摆成一块悬浮窗，并接上拖动与关闭。
 * **不自己重写一个控制台**：Eruda 是现成的页面内调试控制台（Console / Elements / Network /
 * Sources / Storage 全都有），我们只改它的形态。
 */
const START_TAIL = `
;(function () {
  window.__kfwDebugConsoleError = null;
  try {
    if (!window.eruda) {
      window.__kfwDebugConsoleError = "脚本没有把 eruda 挂到 window 上";
      return;
    }
    // 一个页面只开一个：已初始化就只 show，不再 init（重复 init 会叠第二套内部状态）
    if (window.eruda._isInit) {
      window.eruda.show();
    } else {
      window.eruda.init();
      window.eruda.show();
    }
  } catch (error) {
    window.__kfwDebugConsoleError = String(
      (error && (error.stack || error.message)) || error
    );
  }
})();`;

/**
 * 把 Eruda 的容器改造成**三态窗口**（用户口径 2026-10-20）：
 * - **悬浮**（默认）：实底悬浮窗，顶部标签栏拖动移动，右下角缩放；三按钮在**窗外的
 *   梯形容器**里（body 级 fixed，完全不受容器影子根与 overflow 裁剪），**跟随面板
 *   容器右上角**（2026-10-24 用户口径「按钮要在悬浮面板上」：悬浮态贴悬浮窗右上、
 *   分屏态贴分屏卡片右上）；
 * - **最小化**：收成**悬浮球**贴边半藏（浅色半透白+毛玻璃，图标与「打开调试工具」菜单
 *   同款 SquareTerminal），悬停滑出、点击还原、**拖动自由跟手松手吸附最近边**；
 * - **最大化**：贴页面底部的全宽遮罩，上边线 `ns-resize` 上下箭头可拖高度；拖标签栏
 *   可把整块**拿走**（按当前几何转悬浮）。
 *
 * 实现要点：
 * - 容器样式进它所在的 root（影子根里页面样式进不去）；按钮条/悬浮球挂 `document.body`，
 *   样式进 `document.head`——完全脱离容器的影子根，不受 overflow/transform 连坐；
 * - 自家 UI（影子 host / 按钮条 / 悬浮球）一律标 `data-kfw-ui`：元素拾取器见标记即跳过，
 *   否则选择模式下点控制台按钮会被当元素拾取且 preventDefault 吞掉点击（真机踩过）；
 * - 实底：容器显式 `background:#fff`（透明面板被用户圈过）；一个页面只开一个
 *   （`_isInit` 已初始化只 show 不再 init；FLOAT_SCRIPT 幂等标记不叠监听）；
 * - 按钮条 rAF 合帧 + 尺寸缓存，拖动高频 mousemove 不再每次强制回流。
 */
const FLOAT_SCRIPT = `
;(function () {
  try {
  // 重新打开：从任何状态（关闭/悬浮球/分屏卡片）回到悬浮窗（幂等，不叠监听）
  if (window.__kfwFloating) {
    var again = document.querySelector(".eruda-container");
    if (again) again.style.removeProperty("display");
    // 旧版本注入过自绘光标：节点拔掉（其监听若仍挂着只会写已摘除节点，无绘制开销）。
    // 旧监听彻底清掉需要刷新页面；这里保证不再出现双光标/额外布局读取。
    var staleCursor = document.querySelectorAll(".kfw-cursor");
    for (var ci = 0; ci < staleCursor.length; ci += 1) {
      staleCursor[ci].parentNode && staleCursor[ci].parentNode.removeChild(staleCursor[ci]);
    }
    if (window.eruda) window.eruda.show();
    if (window.__kfwConsoleRestore) window.__kfwConsoleRestore();
    return;
  }
  // 容器可能在**影子根**里（Eruda 自己建的）：document.querySelector 穿不过去，
  // 所以先直查、再逐个影子根里找。
  function findContainer() {
    var direct = document.querySelector(".eruda-container");
    if (direct) return direct;
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i += 1) {
      var shadow = all[i].shadowRoot;
      if (!shadow) continue;
      var found = shadow.querySelector(".eruda-container");
      if (found) return found;
    }
    return null;
  }
  var container = findContainer();
  if (!container) {
    window.__kfwDebugConsoleError = "找不到 eruda 容器，没法做成悬浮窗";
    return;
  }
  var root = container.getRootNode ? container.getRootNode() : document;
  // 容器样式必须进**它所在的 root**（影子根里页面样式进不去）；
  // 按钮条/悬浮球/自绘光标挂 document.body（完全脱离容器的影子根与 overflow 裁剪），
  // 样式进 document.head。自家 UI 一律标 data-kfw-ui——元素拾取器见标记即跳过，
  // 否则选择模式下点控制台按钮会被当元素拾取且 preventDefault 吞掉点击。
  if (root.host && root.host.setAttribute) {
    root.host.setAttribute("data-kfw-ui", "console");
  }
  var style = document.createElement("style");
  style.textContent =
    ".eruda-container{position:fixed!important;background:#fff!important;" +
    "z-index:2147483646!important;pointer-events:auto!important;box-sizing:border-box!important}" +
    // 悬浮态：位置/尺寸都由 CSS 变量驱动（拖动改 left/top，角柄改宽高）。
    // 默认 top:44px 只留一点视口顶部呼吸位（按钮条已恒定贴视口右上，不再依赖此值）。
    ".eruda-container.kfw-float{left:24px;top:44px;right:auto!important;bottom:auto!important;" +
    "width:var(--kfw-w,460px)!important;height:var(--kfw-h,340px)!important;" +
    "max-width:none!important;max-height:none!important;border-radius:6px!important;" +
    "box-shadow:0 10px 28px rgba(0,0,0,.35)!important;overflow:hidden!important}" +
    // 分屏卡片态：贴底全宽、**上边无圆角**（平边停靠），高度由 --kfw-mh 驱动（上边线拖拽改它）
    ".eruda-container.kfw-max{left:0!important;right:0!important;top:auto!important;bottom:0!important;" +
    "width:auto!important;height:var(--kfw-mh,60vh)!important;max-width:none!important;" +
    "max-height:none!important;border-radius:0!important;" +
    "box-shadow:0 -8px 28px rgba(0,0,0,.35)!important;overflow:hidden!important}" +
    // Eruda 的正文面板自己留了一条顶部空档（原来是放标题的）：拉满整块，
    // 同时让可见的标签栏正好落在拖动条里。
    ".eruda-dev-tools{top:0!important;height:100%!important;pointer-events:auto!important}" +
    ".eruda-entry-btn{display:none!important}" +
    // 分屏卡片的上边线：上下箭头光标 + 拖拽改高度（热区 20px，灵敏度优先）
    ".kfw-edge{position:absolute;left:0;right:0;top:-10px;height:20px;cursor:ns-resize;" +
    "z-index:2147483647;display:none}" +
    ".eruda-container.kfw-max .kfw-edge{display:block}" +
    // 悬浮态右下角缩放手柄（热区 22px；卡片态藏起）
    ".kfw-corner{position:absolute;right:0;bottom:0;z-index:2147483647;width:22px;height:22px;" +
    "cursor:nwse-resize;background:linear-gradient(135deg,transparent 45%,#999 45%,#999 55%,transparent 55%)}" +
    ".eruda-container.kfw-max .kfw-corner{display:none}";
  (root.head || root).appendChild(style);

  var headStyle = document.createElement("style");
  headStyle.textContent =
    // 三按钮的**直角梯形**容器（直角在右边：右边竖直、左上收斜边），贴面板右上角外，
    // 空白处可**拖动整个面板**（把手语义，见 btnbar mousedown）。
    // 梯形只做**背景层**（伪元素）：clip-path 放在容器上会把最左按钮的左上角裁掉，
    // 点击从被裁区域穿透到页面（真机：点到百度顶部导航，看起来像「按钮没反应+页面卡死」）。
    // 配色**白底深字**（用户口径 2026-10-23「不要改颜色」；2026-10-24 复核：按钮已回
    // 面板上，面板本身就是视觉锚点，黑色描边（四向 drop-shadow）不再需要，只留软投影。
    // 斜边**陡**（用户口径 2026-10-23「斜边梯度陡一点」）：polygon 起点 14%，
    // 斜坡完全落在按钮左侧留白里（38% 时斜坡从最左按钮左上角穿过＝「面板错位」）。
    // 按钮**加大**（用户口径 2026-10-24「按钮太小了」）：18→24px、字 15px；
    // hover 反馈**加深**（同轮「悬浮效果有延迟」——画面流本身有数十 ms 延迟不可消除，
    // 反馈对比度拉满让效果一出来就可见）：#eee→#d9d9d9。
    ".kfw-btnbar{position:fixed;z-index:2147483647;display:flex;gap:2px;padding:3px 0 3px 30px;" +
    "background:transparent;box-shadow:none;cursor:grab}" +
    ".kfw-btnbar::before{content:'';position:absolute;inset:0;z-index:-1;" +
    "background:#fff;" +
    "filter:drop-shadow(0 2px 6px rgba(0,0,0,.22));" +
    "clip-path:polygon(14% 0,100% 0,100% 100%,0 100%)}" +
    ".kfw-btn{width:24px;height:24px;line-height:22px;font-size:15px;font-family:system-ui,sans-serif;" +
    "border:1px solid rgba(0,0,0,.2);border-radius:4px;background:#fff;color:#333;cursor:pointer;padding:0}" +
    ".kfw-btn:hover{background:#d9d9d9}" +
    // 悬浮球：浅色半透白 + 毛玻璃、36px、贴边半藏 55%、悬停近全露；
    // 拖动时脱离贴边自由跟手（kfw-ball-drag），松手吸附最近边
    ".kfw-ball{position:fixed;z-index:2147483647;width:36px;height:36px;border-radius:50%;" +
    "background:rgba(255,255,255,.6);color:#555;border:1px solid rgba(0,0,0,.12);" +
    "backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);" +
    "display:none;align-items:center;justify-content:center;opacity:.9;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.18);cursor:grab;" +
    "transition:transform .12s ease,opacity .1s ease}" +
    ".kfw-ball:hover{opacity:1}" +
    ".kfw-ball svg{display:block}" +
    ".kfw-ball-left{transform:translateX(-55%)}" +
    ".kfw-ball-right{transform:translateX(55%)}" +
    ".kfw-ball-left:hover{transform:translateX(-6%)}" +
    ".kfw-ball-right:hover{transform:translateX(6%)}" +
    // 有经典滚动条时右侧球不再半藏，整球停在内容区内（否则会被滚动条压住）
    ".kfw-ball-inset{transform:none!important}" +
    ".kfw-ball-drag{transform:none!important;transition:none!important;opacity:1;cursor:grabbing}";
  document.head.appendChild(headStyle);

  function mkBtn(glyph, tip, label) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = glyph;
    b.title = tip;
    b.setAttribute("aria-label", label);
    b.className = "kfw-btn";
    return b;
  }
  var btnbar = document.createElement("div");
  btnbar.className = "kfw-btnbar";
  btnbar.title = "按住拖动调试控制台";
  btnbar.setAttribute("data-kfw-ui", "console-buttons");
  var minBtn = mkBtn("–", "最小化为悬浮球", "最小化调试控制台");
  var maxBtn = mkBtn("□", "分屏停靠", "最大化调试控制台");
  var closeBtn = mkBtn("×", "关闭调试控制台", "关闭调试控制台");
  btnbar.appendChild(minBtn);
  btnbar.appendChild(maxBtn);
  btnbar.appendChild(closeBtn);
  document.documentElement.appendChild(btnbar);

  // 按钮条跟随宿主：面板/卡片态贴容器**右上角外**；悬浮球态贴在**球上方**。
  // rAF 合帧 + 尺寸缓存：拖动/缩放的高频 mousemove 里不再每次强制回流。
  //
  // **位置跟随面板容器右上角**（用户口径 2026-10-24「按钮要在悬浮面板上」）：
  // 悬浮态贴悬浮窗右上、分屏态贴分屏卡片右上——面板在哪按钮在哪。
  // （2026-10-23 曾按「连点卡死」改成恒定贴视口右上，用户视角按钮从面板上
  // 消失＝「按钮没了」——连点落空的主体根因是 §225 坐标偏移与 §240 moved 合帧，
  // 均已独立修复，跟随定位回归。）
  // 定位用 viewportWidth()（内容区宽，不含经典滚动条）：CDP 点击的 hit test 也在
  // 内容区坐标里，贴 innerWidth 会把右端压进滚动条、点击落空（§二百二十五 同款事故）。
  var uiState = "float"; // float | max | ball
  function viewportWidth() {
    return document.documentElement.clientWidth || window.innerWidth;
  }
  function viewportHeight() {
    return document.documentElement.clientHeight || window.innerHeight;
  }
  var barW = 0;
  var barH = 30;
  var syncPending = false;
  function syncBtnbar() {
    if (syncPending) return;
    syncPending = true;
    requestAnimationFrame(function () {
      syncPending = false;
      if (uiState === "ball") {
        // 球态不需要按钮条；先退出，避免每帧量 offsetWidth 触发回流。
        btnbar.style.display = "none";
        return;
      }
      if (btnbar.offsetWidth) {
        barW = btnbar.offsetWidth;
        barH = btnbar.offsetHeight || 24;
      }
      var rect = container.getBoundingClientRect();
      var hidden = container.style.display === "none" || rect.width === 0;
      if (hidden) {
        btnbar.style.display = "none";
        return;
      }
      btnbar.style.display = "flex";
      btnbar.style.left = Math.max(0, Math.round(rect.right - barW)) + "px";
      btnbar.style.top = Math.max(0, Math.round(rect.top - barH)) + "px";
    });
  }
  window.addEventListener("resize", function () {
    syncBtnbar();
  });

  // 悬浮球（图标与「打开调试工具」菜单同款：lucide square-terminal）
  var ball = document.createElement("div");
  ball.className = "kfw-ball";
  ball.title = "调试控制台：点击还原悬浮面板，拖动换位置";
  ball.setAttribute("aria-label", "还原调试控制台");
  ball.setAttribute("data-kfw-ui", "console-ball");
  ball.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="m7 11 2-2-2-2"></path><path d="M11 13h4"></path>' +
    '<rect width="18" height="18" x="3" y="3" rx="2"></rect></svg>';
  document.documentElement.appendChild(ball);

  function applyFloat() {
    uiState = "float";
    container.style.removeProperty("display");
    // 隐藏用 visibility / pointer-events，不用 display:none：
    // 控制台 DOM 很大，display 切换会让整棵子树重新布局，卡片↔球与关闭会卡死。
    container.style.removeProperty("visibility");
    container.style.removeProperty("pointer-events");
    container.classList.add("kfw-float");
    container.classList.remove("kfw-max");
    ball.style.display = "none";
    maxBtn.title = "分屏停靠";
    syncBtnbar();
  }
  function applyMax() {
    uiState = "max";
    var rect = container.getBoundingClientRect();
    var height = Math.round(
      Math.max(180, Math.min(rect.height, window.innerHeight * 0.8), window.innerHeight * 0.45),
    );
    container.style.setProperty("--kfw-mh", height + "px");
    container.classList.add("kfw-max");
    container.classList.remove("kfw-float");
    container.style.removeProperty("display");
    container.style.removeProperty("visibility");
    container.style.removeProperty("pointer-events");
    ball.style.display = "none";
    maxBtn.title = "还原悬浮面板";
    syncBtnbar();
  }
  function pageHasVerticalScrollbar() {
    var root = document.scrollingElement || document.documentElement;
    return root.scrollHeight > root.clientHeight + 1;
  }
  function placeBall(side) {
    // 经典滚动条会占 clientWidth；覆盖式滚动条不占宽度但会盖在内容右缘。
    // 两种都算「有滚动条」：右侧球整颗停在内容区内，留 16px 安全边。
    var inset = side === "right" && pageHasVerticalScrollbar();
    ball.className =
      "kfw-ball " +
      (side === "left" ? "kfw-ball-left" : "kfw-ball-right") +
      (inset ? " kfw-ball-inset" : "");
    ball.style.left =
      side === "left"
        ? "0px"
        : Math.round(viewportWidth() - (inset ? 52 : 36)) + "px";
  }
  function applyBall() {
    uiState = "ball";
    // 球贴面板消失前的位置：停靠在面板所在半边、面板顶缘的高度——视线不用动，
    // 点一下球即还原。（2026-10-23 曾固定右缘顶部，那是按钮恒定视口右上的配套；
    // 按钮回面板后球跟着面板走。）
    var rect = container.getBoundingClientRect();
    placeBall(
      rect.left + rect.width / 2 < viewportWidth() / 2 ? "left" : "right",
    );
    ball.style.top =
      Math.max(8, Math.min(Math.round(rect.top), viewportHeight() - 44)) + "px";
    ball.style.display = "flex";
    container.style.setProperty("visibility", "hidden", "important");
    container.style.setProperty("pointer-events", "none", "important");
    syncBtnbar();
  }

  // 最小化：当前状态 ↔ 悬浮球 互切（球态再点 – 回悬浮面板；卡片态点 – 也去球）
  minBtn.onclick = function (event) {
    event.stopPropagation();
    if (uiState === "ball") applyFloat();
    else applyBall();
  };
  // 最大化：悬浮面板 ↔ 分屏卡片 互切（球态点 □ 直接进卡片）
  maxBtn.onclick = function (event) {
    event.stopPropagation();
    if (uiState === "max") applyFloat();
    else applyMax();
  };
  closeBtn.onclick = function (event) {
    event.stopPropagation();
    uiState = "closed";
    // 只做可视隐藏：调用 eruda.hide() 或 display:none 都会让大 DOM 重新布局，
    // 真机上关闭按钮会卡住数秒。重开时 applyFloat 恢复 visibility。
    container.style.setProperty("visibility", "hidden", "important");
    container.style.setProperty("pointer-events", "none", "important");
    ball.style.display = "none";
    btnbar.style.display = "none";
  };

  // 悬浮球：点击还原悬浮面板（球消失），**拖动自由跟手**，松手吸附最近边半藏
  var ballDrag = null;
  ball.addEventListener("mousedown", function (event) {
    event.preventDefault();
    event.stopPropagation();
    ballDrag = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  });
  window.addEventListener("mousemove", function (event) {
    if (!ballDrag) return;
    var dx = event.clientX - ballDrag.x;
    var dy = event.clientY - ballDrag.y;
    if (!ballDrag.moved && dx * dx + dy * dy < 9) return;
    if (!ballDrag.moved) {
      ballDrag.moved = true;
      ball.classList.add("kfw-ball-drag");
      ball.classList.remove("kfw-ball-left", "kfw-ball-right");
    }
    var left = Math.min(
      Math.max(event.clientX - 18, 2),
      viewportWidth() - 38,
    );
    var top = Math.min(Math.max(event.clientY - 18, 60), viewportHeight() - 96);
    ball.style.left = Math.round(left) + "px";
    ball.style.top = Math.round(top) + "px";
    syncBtnbar();
  });
  /**
   * 结束球拖拽（松手或指针离开页面都走这里）。
   *
   * 关键：拖到面板工具栏/窗口外松手时，页面收不到 mouseup——不在这里收尾，
   * ballDrag 永远挂着，之后球会一直追着鼠标跑（真机表现为「拖着拖着消失」）。
   */
  function snapBall() {
    if (!ballDrag) return;
    var moved = ballDrag.moved;
    ballDrag = null;
    if (!moved) {
      applyFloat();
      return;
    }
    // 吸附最近边：左缘 left=0，右缘露出 16px，transform 负责半藏（CSS transition 吸附动画）
    var side =
      parseFloat(ball.style.left) + 18 < viewportWidth() / 2
        ? "left"
        : "right";
    ball.classList.remove("kfw-ball-drag");
    placeBall(side);
    syncBtnbar();
  }
  window.addEventListener("mouseup", snapBall);
  // 指针移出页面（宿主工具栏/窗口外）没有任何 mouseup：按松手收尾，同时清掉
  // 控制台窗口拖动/缩放状态（否则窗口也会继续追着鼠标）。
  window.addEventListener("mouseout", function (event) {
    if (event.relatedTarget) return;
    snapBall();
    dragging = null;
    resizing = null;
  });
  window.__kfwConsoleRestore = applyFloat;

  // 悬浮态右下角缩放手柄：改 CSS 变量（容器宽高由它驱动），夹在可用范围内
  var handle = document.createElement("div");
  handle.className = "kfw-corner";
  handle.title = "拖动调整大小";
  handle.setAttribute("aria-label", "拖动调整调试控制台大小");
  var resizing = null;
  handle.addEventListener("mousedown", function (event) {
    event.preventDefault();
    event.stopPropagation();
    resizing = {
      x: event.clientX,
      y: event.clientY,
      w: container.getBoundingClientRect().width,
      h: container.getBoundingClientRect().height,
    };
  });
  window.addEventListener("mousemove", function (event) {
    if (!resizing) return;
    var w = Math.min(900, Math.max(260, resizing.w + (event.clientX - resizing.x)));
    var h = Math.min(700, Math.max(200, resizing.h + (event.clientY - resizing.y)));
    container.style.setProperty("--kfw-w", w + "px");
    container.style.setProperty("--kfw-h", h + "px");
    syncBtnbar();
  });
  window.addEventListener("mouseup", function () {
    resizing = null;
  });
  container.appendChild(handle);

  // 分屏卡片的上边线：ns-resize 拖拽改高度（向上拖变高）
  var edge = document.createElement("div");
  edge.className = "kfw-edge";
  edge.title = "拖动调整高度";
  edge.setAttribute("aria-label", "拖动调整调试控制台高度");
  var edgeDrag = null;
  edge.addEventListener("mousedown", function (event) {
    event.preventDefault();
    event.stopPropagation();
    edgeDrag = {
      y: event.clientY,
      h: container.getBoundingClientRect().height,
    };
  });
  window.addEventListener("mousemove", function (event) {
    if (!edgeDrag) return;
    var h = Math.min(
      window.innerHeight - 100,
      Math.max(180, edgeDrag.h + (edgeDrag.y - event.clientY)),
    );
    container.style.setProperty("--kfw-mh", Math.round(h) + "px");
    syncBtnbar();
  });
  window.addEventListener("mouseup", function () {
    edgeDrag = null;
  });
  container.appendChild(edge);

  // 拖动（面板/卡片两态通用）：只认顶部那一条（标签栏），按钮/角柄/边线不触发；
  // 下面的正文照常交互。卡片态拖标签栏 = **拿走**：按当前几何转悬浮面板。
  var dragging = null;
  // 开始拖动面板（标签栏与梯形按钮条把手共用）：卡片态先「拿走」转悬浮再拖。
  function startPanelDrag(event) {
    var box = container.getBoundingClientRect();
    if (uiState === "max") {
      // 拿走：以当前几何转悬浮（宽高冻结成变量，边距取现值）
      container.style.setProperty("--kfw-w", Math.round(box.width) + "px");
      container.style.setProperty("--kfw-h", Math.round(box.height) + "px");
      container.classList.remove("kfw-max");
      container.classList.add("kfw-float");
      uiState = "float";
      maxBtn.title = "分屏停靠";
      syncBtnbar();
    }
    dragging = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
    event.preventDefault();
  }
  container.addEventListener(
    "mousedown",
    function (event) {
      var t = event.target;
      if (
        t &&
        t.closest &&
        (t.closest(".kfw-btnbar") || t.closest(".kfw-corner") || t.closest(".kfw-edge"))
      )
        return;
      var box = container.getBoundingClientRect();
      // 48px ≈ 可见标签栏那一条（面板拉满后它就贴着容器顶），热区略放宽
      if (event.clientY - box.top > 48) return;
      startPanelDrag(event);
    },
    true,
  );
  // 梯形按钮条的空白处＝面板把手（用户口径 2026-10-24「按住直角梯形面板也可以
  // 拖动整个面板」）：按钮本身不触发（点击语义），其余区域按住即拖。
  btnbar.addEventListener("mousedown", function (event) {
    var t = event.target;
    if (t && t.closest && t.closest(".kfw-btn")) return;
    startPanelDrag(event);
  });
  window.addEventListener("mousemove", function (event) {
    if (!dragging) return;
    var left = Math.max(0, dragging.left + (event.clientX - dragging.x));
    var top = Math.max(0, dragging.top + (event.clientY - dragging.y));
    container.style.setProperty("left", left + "px", "important");
    container.style.setProperty("top", top + "px", "important");
    syncBtnbar();
  });
  window.addEventListener("mouseup", function () {
    dragging = null;
  });
  applyFloat();
  window.__kfwFloating = true;
  } catch (error) {
    window.__kfwDebugConsoleError = String(
      (error && (error.stack || error.message)) || error
    );
  }
})();`;

/**
 * 已经注入过时的**还原尾巴**（点「打开调试工具」第二次及以后走这里）。
 *
 * 关键：**不重跑源码**。Eruda 是 UMD 包，源码每跑一次 `window.eruda` 就被换成新对象
 * （工厂每次返回新字面量，`_isInit` 复位为 false），START_TAIL 于是再次 `init()`——
 * 页面上多出第二个默认形态的 Eruda（全屏、z-index 9999999、盖住画面），且
 * `applyFloat` 里的 `eruda.show()` 指到新对象，旧容器的正文再也显示不出来
 * （真机：× 关闭后再点「打开调试工具」只剩一个空白框）。所以整段脚本先判
 * `__kfwFloating`：已注入过就只做还原，源码一行不跑。
 *
 * 容器在影子根里（Eruda 默认 `useShadowDom`）：`document.querySelector` 穿不过去，
 * 逐个影子根找；找到就放回 display，再让 eruda 与悬浮窗改造各自复位。
 */
const REOPEN_TAIL = `
  var again = null;
  var directContainer = document.querySelector(".eruda-container");
  if (directContainer) {
    again = directContainer;
  } else {
    var hosts = document.querySelectorAll("*");
    for (var hi = 0; hi < hosts.length; hi += 1) {
      if (!hosts[hi].shadowRoot) continue;
      var inShadow = hosts[hi].shadowRoot.querySelector(".eruda-container");
      if (inShadow) { again = inShadow; break; }
    }
  }
  if (again) again.style.removeProperty("display");
  // 旧版本注入过自绘光标：节点拔掉（残留节点不再绘制，监听随页面刷新才彻底清）
  var staleCursor = document.querySelectorAll(".kfw-cursor");
  for (var ci = 0; ci < staleCursor.length; ci += 1) {
    staleCursor[ci].parentNode && staleCursor[ci].parentNode.removeChild(staleCursor[ci]);
  }
  if (window.eruda) window.eruda.show();
  if (window.__kfwConsoleRestore) window.__kfwConsoleRestore();`;

/**
 * 把源码包成**可注入的一整段**（源码 + 启动尾巴），并在源码运行期间**藏起 AMD / CJS 的全局**。
 *
 * 为什么必须藏：Eruda 是 UMD 包——页面上只要有 `define`（AMD 加载器）或 `module` / `exports`，
 * 它就注册成模块、**不往 `window` 上挂 `eruda`**。真机实测：百度页面上 `typeof window.define`
 * 是 `function`，注入后 `window.eruda` 始终 undefined（用户看到的正是「点了没反应」）。
 * 藏起来它就只能走「浏览器全局」那条分支；跑完（**哪怕源码抛错**）再原样还回去，
 * 别把人家的 AMD 加载器弄坏。
 *
 * 外层用 `.call(window)`：UMD 拿 `this` 当全局对象，包一层之后 `this` 必须仍是 window。
 *
 * **重复注入只还原不重跑**（见 REOPEN_TAIL）：`__kfwFloating` 已置位就直接走还原尾巴，
 * 源码与启动尾巴一行不执行——否则重跑会换掉 `window.eruda` 并再造一个全屏默认容器。
 */
export function buildInjectableScript(source: string): string {
  return `;(function () {
  // 已经注入过：只做还原，**不重跑源码**（重跑的后果见 REOPEN_TAIL 注释）
  if (window.__kfwFloating) {
${REOPEN_TAIL}
    return;
  }
  var hadModule = Object.prototype.hasOwnProperty.call(window, "module");
  var hadExports = Object.prototype.hasOwnProperty.call(window, "exports");
  var hadDefine = Object.prototype.hasOwnProperty.call(window, "define");
  var savedModule = window.module;
  var savedExports = window.exports;
  var savedDefine = window.define;
  try {
    delete window.module; delete window.exports; delete window.define;
  } catch (error) {
    // 删不掉（不可配置）就退一步赋成 undefined：UMD 的 typeof 判断照样会走全局分支
    window.module = undefined; window.exports = undefined; window.define = undefined;
  }
  try {
${source}
  } finally {
    if (hadModule) window.module = savedModule;
    if (hadExports) window.exports = savedExports;
    if (hadDefine) window.define = savedDefine;
  }
${START_TAIL}
}).call(window);
${FLOAT_SCRIPT}`;
}

export interface DebugConsoleSource {
  /** 可注入的完整脚本（源码 + 启动尾巴）。取不到时抛可读错误。 */
  script(): Promise<string>;
}

export function createDebugConsoleSource(
  options: { fetchImpl?: typeof fetch; url?: string } = {},
): DebugConsoleSource {
  const url = options.url ?? DEBUG_CONSOLE_SCRIPT_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  let cached: Promise<string> | null = null;

  const load = async (): Promise<string> => {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new CdpError(
        "command_failed",
        `拿不到调试控制台脚本（${url} 返回 ${response.status}）。`,
      );
    }
    const source = await response.text();
    if (!source.trim()) {
      throw new CdpError("command_failed", "调试控制台脚本是空的，没法注入。");
    }
    return buildInjectableScript(source);
  };

  return {
    script() {
      cached ??= load().catch((error: unknown) => {
        // 失败不缓存：网络恢复后下一次还能成功
        cached = null;
        throw error instanceof Error
          ? error
          : new CdpError("command_failed", "拿不到调试控制台脚本。");
      });
      return cached;
    },
  };
}

/**
 * 注入后自检：脚本真的在页面里生效了吗？
 *
 * 真机教训：只报「已注入」是不够的——脚本没落地时用户看到的是「点了没反应」，
 * 而界面还在说成功。这里读三样东西：脚本有没有挂上 `eruda`、Eruda 自己置的初始化位
 * `_isInit`、以及**页面侧自报的失败原因**（`__kfwDebugConsoleError`，见上面尾巴）。
 */
export const DEBUG_CONSOLE_PROBE = `JSON.stringify({
  loaded: typeof window.eruda !== "undefined",
  initialized: Boolean(window.eruda && window.eruda._isInit),
  containers: document.querySelectorAll(".eruda-container").length,
  error: window.__kfwDebugConsoleError || null
})`;

export interface DebugConsoleProbeResult {
  loaded: boolean;
  initialized: boolean;
  containers: number;
  error: string | null;
}

/** 解析自检探针的返回（页面给的是 JSON 串；拿不到就当作「没生效」）。 */
export function parseDebugConsoleProbe(
  value: unknown,
): DebugConsoleProbeResult {
  const fallback: DebugConsoleProbeResult = {
    loaded: false,
    initialized: false,
    containers: 0,
    error: null,
  };
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value) as Partial<DebugConsoleProbeResult>;
    return {
      loaded: parsed.loaded === true,
      initialized: parsed.initialized === true,
      containers: typeof parsed.containers === "number" ? parsed.containers : 0,
      error: typeof parsed.error === "string" ? parsed.error : null,
    };
  } catch {
    return fallback;
  }
}
