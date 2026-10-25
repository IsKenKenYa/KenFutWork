// @vitest-environment jsdom
/// <reference lib="dom" />

import { describe, expect, it, vi } from "vitest";

import {
  buildInjectableScript,
  createDebugConsoleSource,
  DEBUG_CONSOLE_PROBE,
  DEBUG_CONSOLE_SCRIPT_URL,
} from "./debug-console.js";

/**
 * 调试控制台脚本来源（「打开调试工具」注入的那份 Eruda）。
 *
 * 关键取舍在这里钉住：**整段源码直投**（而不是往页面里插 `<script src=…>`）——
 * 真机撞到过「注入报成功、页面上什么都没有」。所以测试盯三件事：只取一次（缓存）、
 * 带上启动尾巴（幂等地 init + show）、失败要可读且**不缓存**（网络恢复后还能成）。
 */
describe("调试控制台脚本来源", () => {
  const okFetch = (source = "window.eruda = {};"): typeof fetch =>
    vi.fn(
      async () => new Response(source, { status: 200 }),
    ) as unknown as typeof fetch;

  it("取一次就缓存（几百 KB，不该每次点都下载）", async () => {
    const fetchImpl = okFetch();
    const source = createDebugConsoleSource({ fetchImpl });
    const first = await source.script();
    const second = await source.script();
    expect(first).toBe(second);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      DEBUG_CONSOLE_SCRIPT_URL,
    );
  });

  it("脚本尾部接上「初始化 + 显示」（幂等：重复点只是再 show 一次）", async () => {
    const source = createDebugConsoleSource({
      fetchImpl: okFetch("var x = 1;"),
    });
    const script = await source.script();
    // 源码整段在里面（外面套着 UMD 分支修正的壳，见后面的用例）
    expect(script).toContain("var x = 1;");
    expect(script).toContain("window.eruda.init()");
    expect(script).toContain("window.eruda.show()");
  });

  it("HTTP 不是 200：可读错误（带状态码与来源）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;
    const source = createDebugConsoleSource({ fetchImpl });
    await expect(source.script()).rejects.toThrow(/503/);
  });

  it("空脚本：不返回空串（注入了也等于没注入）", async () => {
    const source = createDebugConsoleSource({ fetchImpl: okFetch("   ") });
    await expect(source.script()).rejects.toThrow(/空的/);
  });

  it("失败不缓存：网络恢复后下一次能成", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? new Response("boom", { status: 500 })
        : new Response("window.eruda = {};", { status: 200 });
    }) as unknown as typeof fetch;
    const source = createDebugConsoleSource({ fetchImpl });
    await expect(source.script()).rejects.toThrow();
    await expect(source.script()).resolves.toContain("window.eruda");
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it("自检探针读的是 Eruda 自己置的初始化位", () => {
    expect(DEBUG_CONSOLE_PROBE).toContain("eruda");
    expect(DEBUG_CONSOLE_PROBE).toContain("_isInit");
  });
});

/**
 * UMD 分支（真机踩到的根因）：Eruda 是 UMD 包，页面上只要有 `define`（AMD 加载器）或
 * `module` / `exports`，它就注册成模块、**不往 window 上挂 eruda**——百度这类站点正是如此
 * （`typeof window.define === "function"`），用户那边看到的就是「点了没反应」。
 * 所以注入前要把它藏起来（跑完还回去）。下面用一段**同形状的 UMD 包**把这条钉死。
 */
describe("可注入脚本：UMD 分支修正", () => {
  /** 与 Eruda 同形状的 UMD 包（三种分支都写全）。 */
  const FAKE_UMD = `(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.eruda = factory());
  })(this, function () {
    return {
      _isInit: false,
      init: function () { this._isInit = true; },
      show: function () { window.__erudaShown = true; }
    };
  });`;

  it("页面有 AMD 加载器（define.amd）时也走浏览器全局分支，并把 define 原样还回去", () => {
    const amdCalls: unknown[] = [];
    const originalDefine = Object.assign(
      (...args: unknown[]) => {
        amdCalls.push(args);
      },
      { amd: {} },
    );
    Reflect.set(window, "define", originalDefine);
    Reflect.deleteProperty(window, "eruda");

    // 直接跑我们组装出来的注入脚本（与 Runtime.evaluate 里执行的是同一段）
    // biome-ignore lint/security/noGlobalEval: 这条测试就是要跑页面侧脚本
    const runScript = eval;
    runScript(buildInjectableScript(FAKE_UMD));

    const eruda = (window as unknown as { eruda?: { _isInit?: boolean } })
      .eruda;
    expect(eruda).toBeTruthy();
    expect(eruda?._isInit).toBe(true);
    expect((window as unknown as { __erudaShown?: boolean }).__erudaShown).toBe(
      true,
    );
    // AMD 加载器没被塞进我们的包，且**原样还在**
    expect(amdCalls).toEqual([]);
    expect((window as unknown as { define?: unknown }).define).toBe(
      originalDefine,
    );
    Reflect.deleteProperty(window, "define");
  });

  it("三态窗口改造：实底悬浮 + 悬浮球 + 贴底最大化 + 边线拖高", () => {
    const script = buildInjectableScript("var x = 1;");
    expect(script).toContain("getRootNode");
    expect(script).toContain(".eruda-container{position:fixed");
    // 正文面板拉满：Eruda 自己留的顶部空档在悬窗形态下是**透明死区**（用户圈过）
    expect(script).toContain(
      ".eruda-dev-tools{top:0!important;height:100%!important;pointer-events:auto!important}",
    );
    // 实底：容器显式上底色——透明面板被用户圈过（页面内容透出来像坏掉）
    expect(script).toContain("background:#fff!important");
    expect(script).toContain('setProperty("left"');
    expect(script).toContain("__kfwFloating = true");
    // ✕ 的层级必须高过 Eruda 正文面板（它是 500）——低了就被盖住、点不到
    expect(script).toContain("z-index:2147483647");
    // 右下角缩放手柄：改 CSS 变量（容器宽高由 --kfw-w/--kfw-h 驱动）
    expect(script).toContain("--kfw-w");
    expect(script).toContain("nwse-resize");
    // 关闭/最小化用 visibility 收起：display:none 会让大 DOM 重新布局导致卡死
    expect(script).toContain(
      'setProperty("visibility", "hidden", "important")',
    );
    expect(script).not.toContain('setProperty("display", "none", "important")');
    // 重新打开要放回来（幂等分支里），并从任何状态回到悬浮窗
    expect(script).toContain('removeProperty("display")');
    expect(script).toContain("__kfwConsoleRestore");
    // 悬浮球贴内容区右缘（clientWidth 扣掉滚动条），不被右侧滚动条盖住
    expect(script).toContain("document.documentElement.clientWidth");
    expect(script).toContain("kfw-ball-inset");
    // 按钮加大（用户 2026-10-24「按钮太小了」）：24px 按钮 + 30px 左探出（梯形把手）；
    // 梯形 80% 不透明（用户 2026-10-24「不透明度改成 80%，一点点透明」）
    expect(script).toContain("padding:3px 0 3px 30px");
    expect(script).toContain("cursor:grab;opacity:.8}");
    expect(script).toContain("width:24px;height:24px");
    expect(script).not.toContain("width:18px");
    expect(script).not.toContain("min-width:112px");
    // 梯形空白处＝面板拖动把手（用户 2026-10-24「按住直角梯形面板也可以拖动」）：
    // 与标签栏共用 startPanelDrag，卡片态按住先拿走转悬浮
    expect(script).toContain("function startPanelDrag");
    expect(script).toContain('btnbar.addEventListener("mousedown"');
    expect(script).toContain('t.closest(".kfw-btn")');
    // 最小化 = 悬浮球贴边半藏（左右两侧），点击还原、拖动换位置
    expect(script).toContain("kfw-ball-left");
    expect(script).toContain("kfw-ball-right");
    // 灵敏度/形态口径（用户 2026-10-20）：贴边半藏 55%、悬停近全露；球 36px、
    // 更浅的中性半透白、拖动自由跟手松手吸附
    expect(script).toContain("translateX(-55%)");
    expect(script).toContain("translateX(-6%)");
    expect(script).toContain("width:36px");
    expect(script).toContain("rgba(255,255,255,.6)");
    expect(script).not.toContain("rgba(255,255,255,.82)");
    expect(script).toContain("opacity:.9");
    // 悬浮球图标与「打开调试工具」菜单同款（lucide square-terminal 的三段路径）
    expect(script).toContain('<path d="m7 11 2-2-2-2"></path>');
    expect(script).toContain('<path d="M11 13h4"></path>');
    // 最大化 = 分屏卡片（贴底全宽、**上边无圆角**），上边线 ns-resize（上下箭头）
    // 拖高度（--kfw-mh）；拖标签栏 = 拿走（按当前几何转悬浮）
    expect(script).toContain("kfw-max");
    expect(script).toContain("border-radius:0!important");
    expect(script).toContain("ns-resize");
    expect(script).toContain("--kfw-mh");
    expect(script).toContain("top:-10px;height:20px");
    // 一个页面只开一个：已初始化只 show 不再 init
    expect(script).toContain("window.eruda._isInit");
    // 三按钮在**窗外的小号直角梯形**容器里（直角在右边：右竖左斜），body 级 fixed；
    // 球态/关闭态按钮条隐藏（syncBtnbar 的 ball 分支与 closeBtn）
    expect(script).toContain("kfw-btnbar");
    // 按钮条挂 documentElement：与页面顶部导航同 z-index 时以更晚绘制顺序压过它
    expect(script).toContain("document.documentElement.appendChild(btnbar)");
    // 斜边**陡**（用户口径 2026-10-23「斜边梯度陡一点」）：38% 起坡水平跨 33px，
    // 正好从最左按钮「–」的左上角穿过——背景在按钮角上缺一块（用户看到的
    // 「按钮面板错位」就是它）。14% 后斜坡完全落在按钮左侧留白里。
    expect(script).toContain(
      "clip-path:polygon(14% 0,100% 0,100% 100%,0 100%)",
    );
    expect(script).not.toContain("polygon(38%");
    expect(script).toContain('uiState === "ball"');
    expect(script).toContain("function syncBtnbar");
    // 按钮条跟随面板容器右上角（用户口径 2026-10-24「按钮要在悬浮面板上」）：
    // 悬浮态贴悬浮窗右上、分屏态贴卡片右上、拖动面板时按钮实时跟随。
    // （2026-10-23 曾因「连点卡死」改为恒定贴视口右上，用户视角＝按钮从面板上消失。）
    expect(script).toContain("rect.right - barW");
    expect(script).toContain("rect.top - barH");
    expect(script).not.toContain("viewportWidth() - barW");
    // 白底深字（用户口径 2026-10-23「不要改颜色」：深色版试用后否决，回原配色）
    expect(script).toContain("background:#fff");
    expect(script).toContain("color:#333");
    expect(script).not.toContain("background:#2b3038");
    expect(script).not.toContain("color:#f4f6f8");
    // 无黑色描边（用户口径 2026-10-24「不要黑色描边」：按钮回归面板上，面板自身
    // 是视觉锚点）——只留一条软投影，按钮格浅边框，hover 反馈加深（画面流有数十 ms
    // 延迟不可消除，对比度拉满让效果一出来就可见）
    expect(script).toContain("filter:drop-shadow(0 2px 6px rgba(0,0,0,.22))");
    expect(script).toContain("border:1px solid rgba(0,0,0,.2)");
    expect(script).toContain(".kfw-btn:hover{background:#d9d9d9}");
    expect(script).not.toContain("drop-shadow(0 1px 0 rgba(0,0,0,.45))");
    // 最小化的球停靠在面板所在半边、面板顶缘高度（按钮跟面板走后球也跟面板走）：
    // 视线不用动，点一下球即还原
    expect(script).toContain("placeBall(");
    expect(script).toContain('? "left" : "right"');
    expect(script).toContain("viewportHeight() - 44");
    // 球热区外扩（用户口径 2026-10-24「悬浮球切换回去卡卡的」根因）：半藏 55%
    // 后可点月牙仅 16px，点了落空＝「没反应/卡」；::after 外扩 10px 透明热区
    expect(script).toContain(
      ".kfw-ball::after{content:'';position:absolute;inset:-10px}",
    );
    // 切换语义：最小化＝当前状态 ↔ 悬浮球，**球还原回最小化前的状态**（用户口径
    // 2026-10-24「悬浮球还原回去要有判断」：从卡片最小化回卡片、从悬浮最小化回悬浮）；
    // 最大化＝面板 ↔ 分屏卡片（球态 □ 直进卡片）
    expect(script).toContain("preBallState");
    expect(script).toContain("function restoreFromBall");
    expect(script).toContain('if (uiState === "ball") restoreFromBall();');
    expect(script).not.toContain('if (uiState === "ball") applyFloat();');
    expect(script).toContain('if (uiState === "max") applyFloat();');
    // 分屏卡片贴底全宽（用户口径 2026-10-24「最大化按钮点击行为不对」根因）：
    // 拖动落下的行内 left/top!important 压过 .kfw-max 的 !important，不清掉
    // 卡片被钉在旧悬浮位置；悬浮位置用 lastFloatPos 记忆，回悬浮回原地。
    expect(script).toContain("lastFloatPos");
    expect(script).toContain('removeProperty("left")');
    expect(script).toContain('removeProperty("top")');
    // 自家 UI 标 data-kfw-ui：元素拾取器见标记即跳过（选择模式下按钮必须可点）
    expect(script).toContain('setAttribute("data-kfw-ui"');
    // 自绘光标已移除（悬在宿主浮层下方 + CDP 往返延迟 + 关闭控制台后残留——
    // 真机三条症状压过 resize 光标的收益）：系统光标回到默认表现；
    // 早退分支仍会清理旧版本遗留的 .kfw-cursor 节点。
    expect(script).not.toContain("CURSOR_SVGS");
    expect(script).not.toContain("console-cursor");
    expect(script).toContain(".kfw-cursor");
    // 悬浮球：更浅的半透白 + 拖动自由跟手松手吸附
    expect(script).toContain("rgba(255,255,255,.6)");
    expect(script).toContain("kfw-ball-drag");
    expect(script).toContain("最小化为悬浮球");
    expect(script).toContain("分屏停靠");
  });

  it("源码抛错也要把 define 还回去（不能把人家的加载器弄坏）", () => {
    const originalDefine = Object.assign(() => {}, { amd: {} });
    Reflect.set(window, "define", originalDefine);
    // biome-ignore lint/security/noGlobalEval: 同上，测的就是页面侧执行
    const runScript = eval;
    expect(() =>
      runScript(buildInjectableScript("throw new Error('bundle 炸了');")),
    ).toThrow(/bundle 炸了/);
    expect((window as unknown as { define?: unknown }).define).toBe(
      originalDefine,
    );
    Reflect.deleteProperty(window, "define");
  });

  it("组装顺序：先藏、再跑源码、最后还原", () => {
    const script = buildInjectableScript("SOURCE_MARK");
    expect(script.indexOf("delete window.define")).toBeLessThan(
      script.indexOf("SOURCE_MARK"),
    );
    expect(script.indexOf("SOURCE_MARK")).toBeLessThan(
      script.indexOf("if (hadDefine)"),
    );
    // UMD 拿 this 当全局对象：外层必须仍以 window 为 this
    expect(script).toContain("}).call(window);");
    // 尾部还接了「悬浮窗改造」（可拖动 / 可关闭）
    expect(script).toContain("__kfwFloating");
  });

  it("二次注入只还原不重跑源码：__kfwFloating 早退分支在源码之前", () => {
    // 真机事故：重跑 eruda 源码会把 window.eruda 换成新对象（_isInit 复位），
    // START_TAIL 于是再次 init——页面上多出第二个默认形态的全屏 Eruda，且
    // applyFloat 的 eruda.show() 指到新对象，旧容器正文再也显示不出来
    // （× 关闭后再点「打开调试工具」只剩一个空白框）。整段脚本必须先判
    // __kfwFloating 并 return，源码一行都不执行。
    const script = buildInjectableScript("SOURCE_MARK");
    const guard = script.indexOf("if (window.__kfwFloating)");
    const source = script.indexOf("SOURCE_MARK");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(source);
    // 早退分支必须 return，否则会继续跑源码
    const guardBlock = script.slice(guard, source);
    expect(guardBlock).toContain("return;");
    // 还原尾巴：放回容器 display + 让 eruda 与悬浮窗改造各自复位
    expect(guardBlock).toContain('removeProperty("display")');
    expect(guardBlock).toContain("__kfwConsoleRestore");
  });
});
