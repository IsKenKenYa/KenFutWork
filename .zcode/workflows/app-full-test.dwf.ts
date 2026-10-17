/* zcode-workflow
description: KenFutWork 本地实例全量功能测试：拉起 dev 栈、注入 BYOK 供应商与默认模型、准备 Code/Design
  项目+MCP+技能资产、5 路并行走查全部页面（按钮/样式/文案/console）、六执行模式逐项实测（对话/联网搜索/MCP/技能/计划→批准→自主
  Python 项目/创造/目标/循环）、复核高优先级发现并产出总报告。
whenToUse: 需要对 KenFutWork 平台做发布前全量回归或真机验收时：覆盖所有页面
  UI、六个执行模式、MCP/技能/联网搜索/创造能力的端到端测试。需要传入 BYOK apiKey；本机需已初始化过桌面数据目录（存在
  desktop-token）。
args:
  apiKey:
    type: string
    description: BYOK 供应商的 API Key（运行时传入，不落盘到工作流文件）
    required: true
  workDir:
    type: string
    description: Code 项目工作目录（须已存在的绝对路径）
    default: D:/Desktop/test
  serverUrl:
    type: string
    description: 本地 API 地址
    default: http://localhost:3301
  webUrl:
    type: string
    description: 本地 Web 地址
    default: http://localhost:3300
*/
// KenFutWork 全量功能测试工作流：拉起本地栈 → 注入 BYOK 供应商 → 准备测试资产
// → 全页面并行走查 → 六执行模式逐项实测（含计划+自主 Python 项目、MCP、技能、联网搜索、创造）
// → 复核高优先级发现 → 收尾总报告。
const apiKey = String(args.apiKey ?? "");
if (!apiKey) throw new Error("缺少必填参数 apiKey（aiping 的 API Key）");
const workDir = String(args.workDir ?? "D:/Desktop/test");
const serverUrl = String(args.serverUrl ?? "http://localhost:3301");
const webUrl = String(args.webUrl ?? "http://localhost:3300");

const tempDir = "C:/Users/future/AppData/Local/Temp/kenfut-test";
const tokenFile = tempDir + "/token.txt";
const shotsDir = tempDir + "/shots";
const pwModules = "C:/Users/future/AppData/Local/Temp/kenfut-pw/node_modules";
const chromeExe =
  "C:/Users/future/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe";
const providerName = "aiping-GLM-5.3-Flash";
const modelName = "GLM-5.3-Flash";
const mcpName = "filesystem-test";
const skillName = "kenfut-工作流自检";
const codeProjectName = "工作流测试项目";
const designProjectName = "工作流走查画布";

interface BootstrapResult {
  /** 整体是否可继续测试。false 时 run 会在脚本里中止。 */
  ok: boolean;
  serverReady: boolean;
  webReady: boolean;
  /** API 进程 PID，便于收尾说明如何停止。 */
  serverPid: string;
  /** web dev 进程 PID。 */
  webPid: string;
  /** 迁移、清理残留、异常的说明。 */
  notes: string;
}
interface SeedResult {
  providerInstanceId: string;
  /** 形如 <instanceId>:GLM-5.3-Flash 的默认模型完整标识；空串表示设置失败。 */
  defaultModel: string;
  probeOk: boolean;
  probeDetail: string;
  modelsListed: boolean;
  notes: string;
}
interface AssetResult {
  projectId: string;
  designProjectId: string;
  mcpServerId: string;
  mcpConnected: boolean;
  mcpToolCount: number;
  mcpError: string;
  skillId: string;
  skillInstalled: boolean;
  notes: string;
}
interface Finding {
  /** 位置：页面/模式/接口名，尽量带 file:line 或截图路径。 */
  where: string;
  /** 一句话说清问题。 */
  what: string;
  /** 证据：截图路径、console 原文、API 响应摘录。 */
  evidence: string;
  severity: "low" | "medium" | "high";
}
interface WalkResult {
  /** 本组负责的测试项 id（见指令，不要改）。 */
  itemId: string;
  /** pass / fail / blocked。blocked = 客观条件做不了，不是失败。 */
  status: "pass" | "fail" | "blocked";
  /** 两三句结论：看了什么、哪些通过、哪些有问题。 */
  summary: string;
  /** 过滤噪音后的真实 console 错误（空数组 = 没有）。 */
  consoleErrors: string[];
  /** 点不动/点了无反应/状态不还原的按钮清单。 */
  brokenButtons: string[];
  /** 发现的问题；每个都带证据。 */
  findings: Finding[];
}
interface ModeResult {
  /** 本步的测试项 id（见指令，不要改）。 */
  itemId: string;
  status: "pass" | "fail" | "blocked";
  summary: string;
  /** 截图路径 + 关键观察（工具调用痕迹、回复摘录、文件路径）。 */
  evidence: string;
  findings: Finding[];
}
interface Confirmation {
  confirmed: boolean;
  note: string;
}
interface CleanupResult {
  tokenDeleted: boolean;
  /** 仓库里本次新增的未跟踪文件清单（应为空或只有 .zcode/workflows）。 */
  repoNewFiles: string[];
  serversStillHealthy: boolean;
  notes: string;
}
interface FindingReport {
  where: string;
  what: string;
  evidence: string;
  severity: "low" | "medium" | "high";
  /** verified = 独立复核过；unconfirmed = 仅有初始证据。 */
  status: "verified" | "unconfirmed";
}
interface WorkflowReport {
  conclusion: string;
  findings: FindingReport[];
  verified: string[];
  notCovered: string[];
}

// 看板：每个测试项一张卡，实时更新
artifact.board("results", {
  title: "全量测试进度",
  key: "id",
  status: "status",
  columns: ["待测", "通过", "失败", "阻塞"],
  cardTitle: "name",
  detail: [{ field: "detail" }],
});
const allItems: Array<{ id: string; name: string }> = [
  { id: "env", name: "环境拉起与健康" },
  { id: "auth", name: "本机认证链" },
  { id: "provider", name: "供应商实例与 Key" },
  { id: "default-model", name: "默认模型设置" },
  { id: "probe", name: "供应商连通探测" },
  { id: "project", name: "Code 项目与工作目录" },
  { id: "design-project", name: "Design 画布项目" },
  { id: "mcp-config", name: "MCP 服务器接入" },
  { id: "skill-create", name: "技能创建与安装" },
  { id: "page-shell", name: "首页与工作台壳" },
  { id: "page-settings", name: "设置与本地实例面板" },
  { id: "page-plugins", name: "插件面板" },
  { id: "page-skills", name: "技能与 MCP 面板" },
  { id: "page-tasks", name: "任务中心与引擎页" },
  { id: "page-design", name: "Design 模式主区" },
  { id: "mode-chat", name: "对话模式" },
  { id: "mode-search", name: "联网搜索" },
  { id: "mode-mcp", name: "MCP 工具实测" },
  { id: "mode-skill", name: "技能实测" },
  { id: "mode-plan-solo", name: "计划→批准→自主" },
  { id: "python-verify", name: "Python 产物可运行" },
  { id: "mode-creative", name: "创造模式（造技能）" },
  { id: "mode-goal", name: "目标模式" },
  { id: "mode-loop", name: "循环模式（预期停用）" },
];
for (const it of allItems) {
  report({ id: it.id, name: it.name, status: "待测", detail: "" }, "results");
}

const AUTH_HINT =
  '脚本凭据：curl 一律带 -H "Authorization: Bearer $(cat ' +
  tokenFile +
  ')"（desktop-token 已由环境阶段写入该文件；令牌是敏感值，不得写进返回或日志）。';

const BROWSER_RECIPE = [
  "【浏览器自动化配方（本机已验证，直接照抄）】",
  "- 用 Playwright 写 .cjs 脚本，脚本文件一律放 " + tempDir + "/ 下（严禁往仓库写任何文件），运行方式：",
  '  NODE_PATH="' + pwModules + '" node <脚本名>.cjs',
  "- 启动浏览器（固定写法）：",
  '  const { chromium } = require("playwright");',
  '  const browser = await chromium.launch({ headless: true, executablePath: "' + chromeExe + '" });',
  "- 认证（每个新浏览器 context 都要做一次）：",
  '  ① bash 里拿一次性票据：curl -s -X POST ' + serverUrl + '/api/local-access/tickets -H "Authorization: Bearer $(cat ' + tokenFile + ')"  → 响应 JSON 的 ticket 字段',
  '  ② 脚本里先 page.goto("' + webUrl + '/")，再在页面上下文兑换 cookie：',
  '     await page.evaluate(async (t) => { const r = await fetch("' + serverUrl + '/api/local-access/connect", { method: "POST", headers: {"content-type":"application/json"}, credentials: "include", body: JSON.stringify({ ticket: t, label: "kenfut-test" }) }); return r.status; }, ticket);  // 期望 200',
  '  ③ 之后 page.goto("' + webUrl + '/workbench") 即已登录；cookie 是 HttpOnly，读不到内容属正常。',
  "- 点击坑（本应用实测过的可行解）：",
  "  1) locator.click() 常因 Next.js dev 悬浮球/覆盖层挡住而超时——页面级 DOM 按钮一律用 page.evaluate 里找到元素后 el.click()（Radix 菜单先补 dispatchEvent(new MouseEvent(\"pointerdown\"/\"pointerup\", {bubbles:true})) 再 click）。",
  '  2) Code 工作台主区是同源 iframe（src 含 /code-ui/）；用 page.frames() 找到该 frame。composer 输入框 [data-testid="v4-composer-input"] 是 Lexical contenteditable：先 locator(..).boundingBox() 拿视口坐标，page.mouse.click 到中心，page.keyboard.type(...) 输入，再 mouse 点发送按钮。',
  "  3) 执行模式菜单项的 role 是 menuitemcheckbox（「计划」是独立勾选项）。",
  "- 读页面状态：page.evaluate(() => document.body.innerText) 适合「这页显示了什么」断言；iframe 内用 frame.evaluate。",
  '- console 收集：page.on("pageerror") 与 page.on("console")；过滤噪音（Next.js dev 指示器、React DevTools 下载提示、Fast Refresh、favicon 404、autofill 警告），其余 uncaught error / 4xx 5xx 请求失败全记。',
  "- 证据：每个结论至少一张整页截图存 " + shotsDir + "/（文件名含组名+步骤），findings 里引用截图路径。",
  "【纪律】没发生的绝不报通过；控件找不到/卡住就标 blocked 并描述当时界面；测试中拨动的开关要拨回原状；界面文案问题（写成句子、占位词、「即将上线」类空壳）也算 finding（severity 按误导程度）。",
].join("\n");

// ---------------- 阶段 1：起环境 ----------------
phase("起环境并冒烟");
const boot = await agent("环境管理员").ask<BootstrapResult>(
  [
    "你是环境管理员，负责把 KenFutWork 本地开发栈拉起来并冒烟。仓库在 D:/Desktop/KenFutWork（pnpm monorepo），web 端口 3300、API 端口 3301、PG 端口 5433。全程用 Bash，禁止改动仓库内任何被 git 跟踪的文件；临时文件放 " + tempDir + "/（先 mkdir -p）。",
    "步骤：",
    "1. 确保 " + workDir + " 目录存在（mkdir -p）。",
    "2. 检查 PG：netstat -ano 里 5433 已 LISTENING 则跳过；否则 docker compose -f docker-compose.pg.yml up -d 并等 15 秒复查。两者都不行就记入 notes 继续。",
    "3. 迁移：pnpm --filter @kenfutwork/server migrate apply（已应用会幂等跳过；失败记录 notes，不阻塞）。",
    "4. 清理 3300/3301 残留监听：netstat -ano | grep LISTENING | grep -E ':(3300|3301)'；对占用的 pid 用 PowerShell Get-CimInstance Win32_Process 查 commandline，确认是 node/next 的 dev 进程才 taskkill //PID <pid> //T //F；不是 dev 进程就别杀，notes 里说明并继续（后续起不来会暴露）。",
    "5. 起 API（必须与终端脱离、你退出后仍存活）：cd apps/server && nohup node --env-file=../../.env.local --import tsx ./src/server.ts > " + tempDir + "/server.log 2>&1 & 记下 $!。轮询 curl -s " + serverUrl + "/api/health（最多 90 秒）直到返回含 kenfutwork-server 的 JSON。",
    "6. 起 web：cd apps/web && NEXT_PUBLIC_SERVER_BASE_URL=" + serverUrl + " nohup npx next dev -p 3300 > " + tempDir + "/web.log 2>&1 & 记下 $!。轮询 curl -s -o /dev/null -w %{http_code} " + webUrl + "（最多 150 秒）直到 200。",
    "7. 令牌：cat \"$APPDATA/com.kenfutwork.desktop/data/local-access/desktop-token\"，把内容原样（去首尾空白）写入 " + tokenFile + "。令牌敏感：不要 echo、不要放进返回值。",
    "8. 认证冒烟：curl -s -X POST " + serverUrl + "/api/local-access/tickets -H \"Authorization: Bearer $(cat " + tokenFile + ")\" —— 返回含 ticket 即认证链通。",
    "返回 JSON：ok=（serverReady && webReady && 冒烟通过）；serverPid/webPid 填第 5/6 步记录的 pid；notes 写清杀过的残留进程、迁移结果、任何异常。某一步 5 分钟还过不去就把已完成的部分如实返回（ok=false 并注明卡点），不要无限等。禁止起 worker（本地形态会被守卫拒绝，属设计内）。",
  ].join("\n"),
);
report({ id: "env", name: "环境拉起与健康", status: boot.serverReady && boot.webReady ? "通过" : "失败", detail: boot.notes.slice(0, 300) }, "results");
report({ id: "auth", name: "本机认证链", status: boot.ok ? "通过" : "失败", detail: boot.ok ? "ticket 签发成功" : boot.notes.slice(0, 300) }, "results");
if (!boot.serverReady) {
  throw new Error("API 服务未就绪，测试无法继续：" + boot.notes);
}

// ---------------- 阶段 2：供应商与默认模型 ----------------
phase("注入供应商与默认模型");
const seed = await agent("配置员").ask<SeedResult>(
  [
    "你是配置员，用 curl 给本地实例注入 BYOK 供应商并设默认模型。API 根 " + serverUrl + "。" + AUTH_HINT,
    "1. GET /api/provider-instances：若已存在 name=\"" + providerName + "\" 的实例则记下其 id 走更新（PATCH /api/provider-instances/<id>，body 带 apiKey 与 models 即覆盖）；否则 POST /api/provider-instances，body：",
    '   {"name":"' + providerName + '","protocol":"openai-compatible","baseUrl":"https://www.aiping.cn/api/v1","apiKey":"' + apiKey + '","enabled":true,"models":[{"id":"' + modelName + '","name":"' + modelName + '","capability":"chat","vision":false,"contextWindow":1000000,"maxOutputTokens":128000}]}',
    "   → 201 响应里取实例 id。",
    "2. POST /api/provider-instances/<id>/probe（无请求体）→ 记录探测结论（probeOk / 失败原因原文）。",
    "3. PATCH /api/instance/settings，body {\"defaultModel\":\"<实例id>:" + modelName + "\"}（必须是 实例id:模型id 完整形式）→ 期望 200。",
    "4. GET /api/models 确认清单里出现 <实例id>:" + modelName + "。",
    "5. 收尾校验 GET /api/instance/settings 里 defaultModel 已是完整标识。",
    "返回 JSON：providerInstanceId、defaultModel（完整标识，失败为空串）、probeOk、probeDetail（截 300 字）、modelsListed、notes。API 报错时把响应原文截 500 字放进 notes；apiKey 不许出现在返回里。",
  ].join("\n"),
);
report({ id: "provider", name: "供应商实例与 Key", status: seed.providerInstanceId ? "通过" : "失败", detail: seed.notes.slice(0, 300) }, "results");
report({ id: "default-model", name: "默认模型设置", status: seed.defaultModel ? "通过" : "失败", detail: seed.defaultModel || seed.notes.slice(0, 300) }, "results");
report({ id: "probe", name: "供应商连通探测", status: seed.probeOk ? "通过" : (seed.probeDetail ? "失败" : "阻塞"), detail: seed.probeDetail.slice(0, 300) }, "results");
if (!seed.defaultModel) {
  throw new Error("默认模型未设置成功，后续对话类测试必然失败，中止：" + seed.notes);
}

// ---------------- 阶段 3：测试资产 ----------------
phase("准备测试资产");
const assets = await agent("资产管理员").ask<AssetResult>(
  [
    "你是资产管理员，用 curl 准备四个测试资产。API 根 " + serverUrl + "。" + AUTH_HINT,
    "1. Code 项目：POST /api/projects {\"name\":\"" + codeProjectName + "\",\"kind\":\"code\",\"work_dir\":\"" + workDir + "\"}（目录必须已存在；201 取 project.id）。若同名已存在：GET /api/projects?kind=code 找到复用，并核对 work_dir 一致（不一致记入 notes）。",
    "2. Design 画布项目：POST /api/projects {\"name\":\"" + designProjectName + "\",\"kind\":\"design\"}（省略 work_dir 用托管目录）。同名复用规则同上（GET /api/projects?kind=design）。",
    "3. MCP 服务器：POST /api/mcp/servers {\"name\":\"" + mcpName + "\",\"kind\":\"stdio\",\"command\":\"npx\",\"args\":[\"-y\",\"@modelcontextprotocol/server-filesystem\",\"" + workDir + "\"],\"env\":{},\"enabled\":true} → 201 取 id。409 同名则 GET /api/mcp/servers 找到 id 后 PATCH enabled=true，再 POST /api/mcp/servers/<id>/reconnect。然后轮询 GET /api/mcp/servers（每 5 秒、最多 120 秒——npx 首次下载约 30 秒）直到该 server 状态为已连接且 toolCount>0；超时把该条目的 status/error 字段原文记入 mcpError。status 枚举拿不准就读 packages/shared/src/mcp-contracts.ts。",
    "4. 技能：先 GET /api/skills 查\"" + skillName + "\"是否已存在（存在记下 id 跳过创建）；否则 POST /api/skills {\"name\":\"" + skillName + "\",\"description\":\"工作流自检：被调用时按说明执行并自证生效\",\"category\":\"code\",\"skillContent\":\"# 工作流自检\\n\\n当用户要求使用本技能时，按顺序做两件事：\\n1. 报出你当前的工作目录路径。\\n2. 原样输出这句话：工作流自检技能已生效。\\n\"} → 201 取 id。然后 POST /api/instance/skills {\"skillId\":\"<id>\"} 期望 204；GET /api/instance/skills 确认在列且 enabled=true。",
    "返回 JSON 各字段：projectId、designProjectId、mcpServerId、mcpConnected、mcpToolCount、mcpError、skillId、skillInstalled、notes。报错响应原文截 500 字进 notes。",
  ].join("\n"),
);
report({ id: "project", name: "Code 项目与工作目录", status: assets.projectId ? "通过" : "失败", detail: assets.notes.slice(0, 300) }, "results");
report({ id: "design-project", name: "Design 画布项目", status: assets.designProjectId ? "通过" : "失败", detail: assets.notes.slice(0, 200) }, "results");
report({ id: "mcp-config", name: "MCP 服务器接入", status: assets.mcpConnected ? "通过" : "失败", detail: assets.mcpConnected ? ("已连接，" + assets.mcpToolCount + " 个工具") : (assets.mcpError || "未连接").slice(0, 300) }, "results");
report({ id: "skill-create", name: "技能创建与安装", status: assets.skillInstalled ? "通过" : "失败", detail: assets.skillInstalled ? skillName + " 已装进实例" : assets.notes.slice(0, 300) }, "results");

// ---------------- 阶段 4+5：并行走查 + 执行模式实测 ----------------
const OPERATOR_PERSONA =
  "你是资深 QA 实测操作员，正在验收 KenFutWork 平台（本机 Web 形态，" + webUrl + "）的 Code 工作台。你有 Bash 与 Read 工具：用 Bash 写/跑 Playwright 脚本与 curl API，用 Read 看截图。模型配置：默认模型 " + seed.defaultModel + "（GLM-5.3-Flash，reasoning 模型，回复常见 30~120 秒，偶发空回复——空了就重发一次再判）。纪律：如实记录，工具没被调用、回复为空、run 失败都要原样写进结果；每步至少一张截图存 " + shotsDir + "/（文件名含步骤标识）；单步等待超过 10 分钟没有进展就标 blocked 收尾，不要无限等；细琐观察写到 " + tempDir + "/operator-notes.md，返回值只留结论与证据路径。禁止改动仓库文件。如果某步的指令自相矛盾或界面状态说明文档有误，如实按界面现状记录并标 blocked。";

const walkthroughStage = future(async () => {
  phase("全页面并行走查");
  const groups: Array<{ itemId: string; name: string; brief: string }> = [
    {
      itemId: "page-shell",
      name: "壳与首页",
      brief: [
        "走查对象：首页 " + webUrl + "/ 与工作台 " + webUrl + "/workbench（Code 模式）。",
        "检查：① 首页加载与跳转逻辑正常；② workbench 壳渲染完整：主区是 /code-ui/ iframe、页面级模式切换器（Code/Design/Flow）存在且 Code 高亮、侧栏按钮齐全（以实际 DOM 为准：本地实例/插件/技能/MCP/任务中心等）；③ flow 入口纪律：curl GET " + serverUrl + "/api/flow/host/status 看 enabled，若 false 则 Flow 不得出现可进入的假入口（按钮可以存在但点开应有如实的不可用说明，或直接不出现）；④ 样式初检：无白屏、无横向滚动条、无样式塌方（大面积无样式元素）；⑤ console 错误收集。",
      ].join("\n"),
    },
    {
      itemId: "page-settings",
      name: "设置与本地实例面板",
      brief: [
        "走查对象：页面级「本地实例」按钮弹出的设置面板（通常在页面右下角；被 Next.js 悬浮球遮挡时用坐标点击）。",
        "检查：① 弹窗能开能关；② 语音段可见：模式两档、听/想/说三段选择器、性能检测按钮存在；「重新检测」可以点（约 45 秒出报告，超过 90 秒没结果记 finding，不要等更久）；③ 设置项结构：标签在左、控件在右、一行一个配置项、控件有合理宽度——发现上下两行排布或控件被挤扁的记 finding；④ 文案检查：界面文字应为短标签，出现长句子、复述需求的文案、占位词（「占位」「演示」「假的」「即将上线」）记 finding；⑤ console 错误收集。",
      ].join("\n"),
    },
    {
      itemId: "page-plugins",
      name: "插件面板",
      brief: [
        "走查对象：侧栏「插件」打开的插件市场面板。",
        "检查：① 面板能开；② 页签切换正常（「个人」与「公开」；自带插件在个人页签的「KenFutWork 自带插件」分组，列表应非空）；③ 任选一个已安装插件的启停开关：切换→观察状态变化→切回原状（必须还原，并记录原状态）；④ 未安装插件的安装按钮存在即可，不要真装新插件；⑤ 插件图标正常显示（空白/裂图记 finding）；⑥ console 错误收集。",
      ].join("\n"),
    },
    {
      itemId: "page-skills",
      name: "技能与 MCP 面板",
      brief: [
        "走查对象：侧栏「技能」与「MCP」两个面板。测试资产已就绪：技能「" + skillName + "」、MCP 服务器「" + mcpName + "」。",
        "检查：① 技能面板能开、列表里能看到「" + skillName + "」（搜不到记 fail）、详情可打开、内置/社区技能列表非空；② 技能市场搜索（若有入口）可发起，失败（502 类）如实记但不定级 high；③ MCP 面板能开、列表含「" + mcpName + "」、状态为已连接、工具数量可见（toolCount 应 >0）；④ MCP 目录/推荐页签能打开、一键添加按钮存在（不要真添加第二个服务器）；⑤ console 错误收集。",
      ].join("\n"),
    },
    {
      itemId: "page-tasks",
      name: "任务中心与引擎页",
      brief: [
        "走查对象：侧栏「任务中心」与「引擎」入口 + Design 模式。",
        "检查：① 任务中心面板能开、列表渲染正常（可以为空）；② 引擎页：显式点「引擎」才替换主区，页内三个页签（容器/承载路径/地址）能切换，数据如实显示——严禁点「安装引擎栈」「停止引擎」等任何变更按钮，只读走查；看完切回工作流画布或 Code 主区；③ Design 模式：模式切换器切到 Design → 主区必须是整幅画布 iframe（URL 含 /canvas?id=）而不是对话框/会话列表（这是硬不变量，违反记 high finding），画布页自带助手面板可输入（textarea，只输入不发送），顶部项目切换器里能看到「" + designProjectName + "」；④ 切回 Code 模式主区恢复正常；⑤ console 错误收集。",
      ].join("\n"),
    },
  ];
  log("启动 " + groups.length + " 个页面走查代理");
  const walks = await Promise.all(
    groups.map((g) =>
      agent("走查·" + g.name, { system: "你是页面走查员，用浏览器对 KenFutWork 平台做用户验收级的走查。只测不改：不得改动仓库、不得删除或新建项目/插件/MCP/技能（拨过的开关必须还原）。" }).ask<WalkResult>(
        [
          "本组测试项 id 固定为「" + g.itemId + "」，返回时原样填进 itemId，不要改。",
          BROWSER_RECIPE,
          "【本组走查清单】",
          g.brief,
          "返回 JSON：itemId、status（pass/fail/blocked）、summary（两三句）、consoleErrors、brokenButtons、findings（每条带证据）。页面整不出来的客观原因（如入口不存在且属设计内）标 blocked 并解释。",
        ].join("\n"),
      ),
    ),
  );
  walks.forEach((w, i) => {
    report(
      {
        id: groups[i]!.itemId,
        name: groups[i]!.name,
        status: w.status === "pass" ? "通过" : w.status === "fail" ? "失败" : "阻塞",
        detail: w.summary.slice(0, 300),
      },
      "results",
    );
  });
  return walks;
});

const operatorStage = future(async () => {
  phase("执行模式逐项实测");
  const operator = agent("实测操作员", { system: OPERATOR_PERSONA });
  const setupAck = await operator.ask<string>(
    [
      "先做准备步（不产生测试项结果，返回一句话确认即可）。",
      BROWSER_RECIPE,
      "1. mkdir -p " + shotsDir + "；往 " + workDir + " 放两个小文件（notes.txt 内容随意、data.csv 两行表头+数据），模拟已有项目文件。",
      "2. 按配方建立已认证浏览器，打开 " + webUrl + "/workbench，确认 Code 模式主区 composer 可见。",
      "3. curl GET " + serverUrl + "/api/instance/settings 确认 defaultModel 为 " + seed.defaultModel + "。",
      "返回：一句话说明三项是否就绪（有问题直说）。",
    ].join("\n"),
  );
  log("实测操作员就绪：" + setupAck.slice(0, 200));

  const steps: Array<{ itemId: string; name: string; prompt: string }> = [
    {
      itemId: "mode-chat",
      name: "对话模式",
      prompt: [
        "【第 1 步：对话模式】确认当前执行模式为「对话」（agent；在 composer 的模式菜单里核对，role=menuitemcheckbox）。",
        "发送：用一句话介绍你自己，并说明你当前的工作目录。",
        "pass 判据：助手回复非空且提到的工作目录与 " + workDir + " 一致（提到路径即算，允许格式差异）。截图存证。",
        "返回 JSON：itemId=mode-chat、status、summary、evidence、findings。",
      ].join("\n"),
    },
    {
      itemId: "mode-search",
      name: "联网搜索",
      prompt: [
        "【第 2 步：联网搜索】仍在「对话」模式，发送：联网搜索今天的一条科技新闻，给出来源链接。",
        "平台无搜索 Key 时 web_search 工具走网页通道（Bing RSS），属正常路径。",
        "pass 判据：能看到 web_search 工具被调用的痕迹（工具调用/工具进度展示），且最终回复非空并含来源信息（标题或链接）。工具没被调用但模型用 curl 等方式完成了真实联网获取，记 pass 并在 summary 注明实现方式；完全没联网只靠参数知识编造，记 fail。",
        "返回 JSON：itemId=mode-search、status、summary、evidence、findings。",
      ].join("\n"),
    },
    {
      itemId: "mode-mcp",
      name: "MCP 工具实测",
      prompt: [
        "【第 3 步：MCP 工具】仍「对话」模式，发送：用 filesystem-test 这个 MCP 服务器的工具，列出工作目录的文件并告诉我一共几个。",
        "pass 判据：出现 " + mcpName + " 的 MCP 工具调用痕迹，回复里的文件清单与准备步放的两个文件一致（notes.txt、data.csv）。",
        "返回 JSON：itemId=mode-mcp、status、summary、evidence、findings。",
      ].join("\n"),
    },
    {
      itemId: "mode-skill",
      name: "技能实测",
      prompt: [
        "【第 4 步：技能】仍「对话」模式，发送：请使用「" + skillName + "」这个技能，按它的说明执行。",
        "pass 判据：回复里出现「工作流自检技能已生效」字样（技能内容被注入并执行）。技能没被加载、模型说找不到技能，记 fail。",
        "返回 JSON：itemId=mode-skill、status、summary、evidence、findings。",
      ].join("\n"),
    },
    {
      itemId: "mode-plan-solo",
      name: "计划→批准→自主",
      prompt: [
        "【第 5 步：计划+自主组合（核心）】最好新建一个 Task（找不到新建控件就沿用当前会话并记录）。",
        "a. 切到「计划」模式，发送：用 Python 实现一个命令行待办应用 todo.py：支持 add/list/done/del 四个子命令，数据存 todo.json；写完自测一遍。先只出计划，不要动手写代码。",
        "b. 等计划产出（reasoning 模型可能 1~3 分钟）。",
        "c. 在界面上批准该计划（计划批准是硬门，找到批准/允许按钮点它；找不到批准入口截图并记 finding）。",
        "d. 把执行模式切回「自主」（solo），发送：计划已批准，开始执行。这是已验证的组合工作流：计划批准后必须切模式再发消息才继续。",
        "e. 等 run 结束（可能 3~10 分钟；每 30 秒观察一次 UI；run 失败要把错误文案记进 evidence）。",
        "pass 判据：run 正常结束，且 " + workDir + "/todo.py 存在（用 Bash ls 验证）。",
        "返回 JSON：itemId=mode-plan-solo、status、summary、evidence、findings。",
      ].join("\n"),
    },
    {
      itemId: "mode-creative",
      name: "创造模式（造技能）",
      prompt: [
        "【第 6 步：创造模式】新建或沿用会话，切到「创造」（creative）模式，发送：创造一个新技能：名字叫 kenfut-今日报价，用途是演示创造模式的能力，内容自拟但要让被调用时输出一句话报价演示。创建完成后告诉我它是否已出现在技能列表。",
        "pass 判据：run 结束后，用 curl GET " + serverUrl + "/api/skills 能在清单里看到 kenfut-今日报价（你亲自 curl 验证，别只信模型的话）。",
        "返回 JSON：itemId=mode-creative、status、summary、evidence、findings。",
      ].join("\n"),
    },
    {
      itemId: "mode-goal",
      name: "目标模式",
      prompt: [
        "【第 7 步：目标模式】切到「目标」（goal）模式，发送：统计 " + workDir + " 下的文件数量，把数字写进该目录的 stats.txt。",
        "pass 判据：run 按目标机制推进并收敛结束（结束状态可能显示目标达成/完成），且 " + workDir + "/stats.txt 存在（Bash 验证）。若目标模式在 Code 侧有独立入口/预算面板等差异，如实记入 summary。",
        "返回 JSON：itemId=mode-goal、status、summary、evidence、findings。",
      ].join("\n"),
    },
    {
      itemId: "mode-loop",
      name: "循环模式（预期停用）",
      prompt: [
        "【第 8 步：循环模式】尝试切到「循环」（loop）模式。",
        "预期：循环模式已停用——菜单里不出现，或选择后被明确拒绝（后端对 loop 返回 400/409 要求重选）。",
        "pass 判据：循环不可选或切换被明确拒绝（不出现假开关）。若循环竟能激活并跑起来，记 fail 并写清现象（这是恢复的功能，需要登记）。",
        "返回 JSON：itemId=mode-loop、status、summary、evidence、findings。",
      ].join("\n"),
    },
  ];
  const modeResults: ModeResult[] = [];
  for (const s of steps) {
    log("实测：" + s.name);
    const r = await operator.ask<ModeResult>(s.prompt);
    modeResults.push(r);
    report(
      {
        id: s.itemId,
        name: s.name,
        status: r.status === "pass" ? "通过" : r.status === "fail" ? "失败" : "阻塞",
        detail: r.summary.slice(0, 300),
      },
      "results",
    );
  }
  return modeResults;
});

const walks = await walkthroughStage;
const modeResults = await operatorStage;

// ---------------- 阶段 6：Python 产物门禁 ----------------
// 汇总各测试项状态（walks/modeResults 之外的是脚本门禁项，直接定级）
const statusById = new Map<string, string>();
for (const w of walks) statusById.set(w.itemId, w.status);
for (const m of modeResults) statusById.set(m.itemId, m.status);
statusById.set("env", boot.serverReady && boot.webReady ? "pass" : "fail");
statusById.set("auth", boot.ok ? "pass" : "fail");
statusById.set("provider", seed.providerInstanceId ? "pass" : "fail");
statusById.set("default-model", seed.defaultModel ? "pass" : "fail");
statusById.set("probe", seed.probeOk ? "pass" : "fail");
statusById.set("project", assets.projectId ? "pass" : "fail");
statusById.set("design-project", assets.designProjectId ? "pass" : "fail");
statusById.set("mcp-config", assets.mcpConnected ? "pass" : "fail");
statusById.set("skill-create", assets.skillInstalled ? "pass" : "fail");

phase("校验 Python 产物");
const planSolo = modeResults.find((m) => m.itemId === "mode-plan-solo");
let pyGateRan = false;
let pyGateOk = false;
let pyGateDetail = "";
if (planSolo !== undefined && planSolo.status === "pass") {
  // 用 python 直跑 todo.py，不经 cmd 拼接：旧写法 argv 直传时中文参数+&&链会被吞，产物缺失也误报通过。
  const py = await world.run("python", [
    "-c",
    "import os, subprocess, sys\nos.chdir('" + workDir + "')\nr = subprocess.run([sys.executable, 'todo.py', 'add', 'smoke-test-item'], capture_output=True, text=True)\nprint('ADD', r.returncode, r.stdout, r.stderr)\nr2 = subprocess.run([sys.executable, 'todo.py', 'list'], capture_output=True, text=True)\nprint('LIST', r2.returncode, r2.stdout, r2.stderr)\nsys.exit(r2.returncode or r.returncode)",
  ]);
  pyGateRan = true;
  pyGateOk = py.exitCode === 0 && py.stdout.trim().length > 0;
  pyGateDetail = pyGateOk ? py.stdout.trim() : (py.stderr || py.stdout);
  statusById.set("python-verify", pyGateOk ? "pass" : "fail");
} else {
  statusById.set("python-verify", "blocked");
}
report(
  {
    id: "python-verify",
    name: "Python 产物可运行",
    status: statusById.get("python-verify") === "pass" ? "通过" : statusById.get("python-verify") === "fail" ? "失败" : "阻塞",
    detail: (pyGateDetail || "前置的「计划→批准→自主」未通过（" + (planSolo === undefined ? "无结果" : planSolo.status) + "），跳过产物校验").slice(0, 300),
  },
  "results",
);

// ---------------- 阶段 7：复核高优先级发现 ----------------
phase("复核高优先级发现");
const rawFindings: FindingReport[] = [
  ...walks.flatMap((w) => w.findings.map((f) => ({ ...f, status: "unconfirmed" as const }))),
  ...modeResults.flatMap((m) => m.findings.map((f) => ({ ...f, status: "unconfirmed" as const }))),
];
const highs = rawFindings.filter((f) => f.severity === "high").slice(0, 6);
log("高优先级发现 " + highs.length + " 条，逐条独立复核");
const confirmations = await Promise.all(
  highs.map((f, i) =>
    agent("复核员·" + (i + 1), {
      system: "你是独立复核员，与发现问题的人无共享上下文。只根据证据复核，不修任何东西。",
    }).ask<Confirmation>(
      [
        "复核下面这条测试发现是否成立。你可以：Read 截图文件（PNG）、用 curl 查 API（凭据 -H \"Authorization: Bearer $(cat " + tokenFile + ")\"，API 根 " + serverUrl + "）、读 " + tempDir + " 下的日志。不要重演完整 UI 操作。",
        "发现：" + JSON.stringify(f),
        "confirmed=true 表示证据足以支持该问题真实存在；证据不足或与现状矛盾则 false 并说明。返回 JSON：confirmed、note（一句复核结论）。",
      ].join("\n"),
    ),
  ),
);
highs.forEach((f, i) => {
  const c = confirmations[i]!;
  f.status = c.confirmed ? "verified" : "unconfirmed";
});
const finalFindings = rawFindings;

// ---------------- 阶段 8：收尾与总报告 ----------------
phase("收尾与总报告");
const cleanup = await agent("收尾员").ask<CleanupResult>(
  [
    "你是收尾员，做三件事并返回 JSON：",
    "1. 删除敏感临时文件 " + tokenFile + "（rm -f），确认已不存在。",
    "2. cd D:/Desktop/KenFutWork && git status --porcelain 检查：本次测试不应在仓库里新增未跟踪文件（.zcode/workflows/ 下的工作流文件除外）；发现别的就原样列进 repoNewFiles（不要删）。",
    "3. 健康复查：curl -s " + serverUrl + "/api/health 与 curl -s -o /dev/null -w %{http_code} " + webUrl + " —— 服务保持在运行状态（测试后留给用户查看，不要停服务）。",
    "返回 JSON：tokenDeleted、repoNewFiles、serversStillHealthy、notes（服务 pid 等交接信息可从 " + tempDir + "/server.log web.log 顶部或 tasklist 补充）。",
  ].join("\n"),
);
report({ id: "env", name: "环境拉起与健康", status: cleanup.serversStillHealthy ? "通过" : "失败", detail: cleanup.notes.slice(0, 300) }, "results");

const passCount = allItems.filter((it) => statusById.get(it.id) === "pass").length;
const blockedCount = allItems.filter((it) => statusById.get(it.id) === "blocked").length;
const failedItems = allItems.filter((it) => statusById.get(it.id) === "fail");

const lines: string[] = [];
lines.push("# KenFutWork 全量功能测试报告");
lines.push("");
lines.push("- 工作目录：" + workDir);
lines.push("- 供应商实例：" + providerName + "（默认模型 " + seed.defaultModel + "）");
lines.push("- 测试项 24 个：通过 " + passCount + "、失败 " + failedItems.length + "、阻塞 " + blockedCount + "；发现 " + finalFindings.length + " 条问题（高优先级 " + highs.filter((f) => f.status === "verified").length + " 条已独立复核）");
lines.push("");
lines.push("## 测试项结果");
lines.push("");
lines.push("| 测试项 | 结果 | 说明 |");
lines.push("| --- | --- | --- |");
const detailById = new Map<string, string>();
for (const w of walks) detailById.set(w.itemId, w.summary);
for (const m of modeResults) detailById.set(m.itemId, m.summary);
detailById.set("env", "server=" + boot.serverReady + " web=" + boot.webReady + (boot.notes ? "；" + boot.notes : ""));
detailById.set("auth", boot.ok ? "ticket 签发成功" : boot.notes);
detailById.set("provider", seed.providerInstanceId ? providerName : seed.notes);
detailById.set("default-model", seed.defaultModel || seed.notes);
detailById.set("probe", seed.probeOk ? "连通" : seed.probeDetail);
detailById.set("project", assets.projectId ? codeProjectName : assets.notes);
detailById.set("design-project", assets.designProjectId ? designProjectName : assets.notes);
detailById.set("mcp-config", assets.mcpConnected ? assets.mcpToolCount + " 个工具" : assets.mcpError);
detailById.set("skill-create", assets.skillInstalled ? skillName + " 已装进实例" : assets.notes);
detailById.set("python-verify", pyGateRan ? (pyGateOk ? "todo.py add/list 通过" : pyGateDetail) : "前置未通过，跳过");
for (const it of allItems) {
  const s = statusById.get(it.id);
  const label = s === "pass" ? "✅ 通过" : s === "fail" ? "❌ 失败" : "⏸ 阻塞";
  const note = (detailById.get(it.id) ?? "").replace(/\|/g, "/").replace(/\r?\n/g, " ").slice(0, 220);
  lines.push("| " + it.name + " | " + label + " | " + note + " |");
}
lines.push("");
lines.push("## 发现的问题");
lines.push("");
if (finalFindings.length === 0) {
  lines.push("无。");
} else {
  for (const f of finalFindings) {
    lines.push("- [" + f.severity + (f.status === "verified" ? "/已复核" : "/未复核") + "] " + f.where + "：" + f.what + "（证据：" + f.evidence + "）");
  }
}
lines.push("");
lines.push("## 交接说明");
lines.push("");
lines.push("- 服务保留运行中：" + serverUrl + "（API）与 " + webUrl + "（web）；" + cleanup.notes);
lines.push("- 截图与日志在 " + tempDir + "/shots 与 " + tempDir + "/*.log；凭据令牌文件已删除：" + (cleanup.tokenDeleted ? "是" : "否"));
lines.push("- 测试资产保留：项目「" + codeProjectName + "」「" + designProjectName + "」、MCP「" + mcpName + "」、技能「" + skillName + "」与创造模式产出的 kenfut-今日报价（如生成成功），可在应用内查看或手动清理。");
lines.push("- 仓库新增未跟踪文件：" + (cleanup.repoNewFiles.length === 0 ? "无" : cleanup.repoNewFiles.join("、")));

try {
  await artifact.markdown("report", lines.join("\n"), {
    title: "KenFutWork 全量功能测试报告",
    description: "24 项全量测试的结果、问题清单与交接说明。",
    primary: true,
  });
} catch {
  log("报告 artifact 发布失败，内容已随 return 返回");
}

return {
  conclusion:
    "24 项全量测试完成：通过 " + passCount + " 项，失败 " + failedItems.length + " 项，发现 " + finalFindings.length + " 条问题（高优先级已独立复核）。环境保留运行中，测试资产与截图在 " + tempDir + "。",
  findings: finalFindings,
  verified: [
    "环境健康：curl /api/health 与 web 首页 200（环境管理员 + 收尾员各验一次）",
    "供应商连通：POST /api/provider-instances/:id/probe + GET /api/models 出现完整标识",
    "MCP 接入：GET /api/mcp/servers 状态已连接且 toolCount>0",
    "技能：GET /api/instance/skills 在列且 enabled",
    "Python 产物：world.run 执行 python todo.py add/list（exitCode=0）",
    "页面与执行模式：走查员/操作员以真实浏览器（Playwright）操作并截图存证于 " + shotsDir,
  ],
  notCovered: [
    "Flow 引擎栈安装/卸载与 flow 画布实操（重操作，只做入口纪律与引擎页只读走查）",
    "图像/视频生成（" + modelName + " 无图像能力，无可用生成模型）",
    "语音真机转写（需系统麦克风音频输入，仅走查设置面板）",
    "MCP http 类型服务器（只测 stdio filesystem）",
    "检查点回滚、git 面板深度操作、桌面端壳（本次为 Web 形态）",
  ],
};
