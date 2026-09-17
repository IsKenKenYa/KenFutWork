# flow 集成方案（futureFlow 子系统 × 第三模式）

> **角色声明**：方案稿——flow 子系统的集成实施蓝图。决策结论与理由的唯一权威在《[改造计划](./改造计划.md)》§6（`DEC-10`…`DEC-13`）；代码现状数字以代码为准。上游仓库以子模块挂载于 `references/futureFlow`（github.com/future73807/futureFlow，MIT，pnpm workspace：frontend + gateway）。

## 1. 背景与定位

- 主仓现有 **design**（画布创作）与 **code**（工作目录 agent）双模式；新增第三种 **flow 模式**：可视化 AI 工作流（编排、发布快照、执行、审计、触发器）。
- 承载体是合作方作者的 futureFlow，三层架构：FlowGram 画布（React 18 + Semi UI + Rsbuild，`/canvas/:id` 为无侧边栏自包含视图）→ 自研 NestJS 网关（TypeORM + PostgreSQL：双模鉴权/扣费三段事务/DSL 转换 3286 行/Dify Console 集成 1732 行）→ 本地 Dify 0.15.3 容器栈（必需依赖、不降级）。
- 完成度：代码卫生好（模块边界清晰、迁移体系完整），但处于 MVP——SQL/Python 节点仅本地试运行、定时触发是进程内 `setInterval`、多轮会话/审批等待缺失、测试是自写脚本体系（不进主仓 CI）。
- 愿景关系：work = flow + agent（但不完全等于）。三引擎并列（design/code/flow），work 是未来超集；**本期不合引擎**，用引擎 SPI 保住未来可组合性（见 §4）。
- **版权地位（已澄清）**：futureFlow 作者 future73807 即本仓协作者（git 历史 377 提交），其自有代码并入本仓没有版权障碍；上游仓库补一个标准 MIT LICENSE 文件属对外规范动作（面向未来外部贡献者与第三方审计），随上游节奏补即可，**不阻塞任何阶段**。

## 2. 已拍板决策（2026-09-17，flow 作者提案 + KenKen 确认；结论与理由见《改造计划》§6.2）

| ID | 决策 | 对集成的影响 |
| --- | --- | --- |
| `DEC-10` | flow 子系统双形态：**独立运行 + 内嵌** | 内嵌模式去品牌、统一风格、身份桥接主仓；独立模式保留自带登录/管理员/bootstrap，单独可跑 |
| `DEC-11` | 执行引擎 = **本地 Dify**（无头栈为默认） | 自托管 Compose 加 dify profile（不跑 dify-web/nginx，Dify logo 条款明文不适用）；桌面形态承载为开放问题（§8.1） |
| `DEC-12` | 计费/凭证网关缝**可插拔** | 独立模式用自带 balance + `LLM_API_KEY`；内嵌模式接主仓 credits/usage（`DEC-5`/`DEC-6`）与 BYOK 实例（`DEC-7`） |
| `DEC-13` | Dify **保持可升级**（MVP 阶段） | 引擎适配层 + 每次升级的 DSL 转换回归门禁（现网关对 0.15.3 有行为兼容硬编码：boolean→number、iteration 展开等） |

## 3. 主仓接缝清单（勘查结论）

| # | 接缝 | 现有机制 | flow 要动什么 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | 工作台主区判定 | `workbench-surface.ts` 纯函数 + design 永不 conversation 不变量 + 测试锁死 | `WorkbenchMode`/`Surface` 加 flow 短路分支（flow 主区恒为画布）+ 穷举回归测试 + AGENTS.md 不变量登记 | 高（历史事故高发区） |
| 2 | 项目类型 kind | `projectKindSchema` 枚举 → DB CHECK → 前端按 kind 取列表 | 枚举加 `"flow"` + **前向迁移**改 CHECK + 第三份列表/侧栏/建项目 | 中 |
| 3 | 画布 iframe 内嵌 | `/canvas?id=` iframe + 同源 localStorage 鉴权 + `workbench:project-created` postMessage | `/flow` 路由页 + 主区 iframe 分支 + 复用 postMessage 通道 | 低（机制现成） |
| 4 | 作用域绑定 | run 必绑项目（硬约束，见 AGENTS.md 历史事故） | flow run 绑 `kind='flow'` 项目；画布 id 即作用域，与 design 同构 | 中 |
| 5 | BYOK 供应商缝 | protocol 封闭枚举 + `provider_instances` 加密存储 + `resolveCredentials`（workspace→system 回退） | flow feature 内凭证注入服务（经 `resolveCredentials` 下发 Dify Provider）；禁止内联供应商判断 | 高（凭证红线 + 封闭集纪律） |
| 6 | 计费 credits | DB 原子扣/退（`FOR UPDATE` + 流水同事务）+ `job_id` 幂等索引 + runtime 平台池额度门；`DEC-5` 目标态默认关 | 按 `DEC-12` 做缝：内嵌态接 credits/usage（flow run id 作幂等键）+ 平台池余额门进 flow 执行入口；独立态保留自带 balance | 中 |
| 7 | 桌面 Tauri 生命周期 | 单子进程 spawn/探活/优雅退出 + 内嵌 PG + 进程内队列 | Dify 8+ 容器超出单子进程模型与内存预算（桌面 ≤900MB）→ 桌面承载待定（§8.1） | 高（架构级） |
| 8 | 插件内核 | kernel ServiceMap + profiles 清单 + plugin 四件套（inject/apply/mounted） | `features/flow/` 插件（工作流定义/版本/运行记录）+ ServiceMap 登记一处 +《改造计划》§4.2 一处 | 低 |
| 9 | 队列 job | `backgroundJobTypeSchema` 仅图/视频 + `registerExecutor()` | flow 执行需后台化时扩 `flow_execution` job 类型 + executor | 中 |
| 10 | WS 事件 | `streamEventSchema` 判别联合 + canvasId 锚定推送 + `lastSeq` 断线重放 | 加 `flowRun.*` 事件；flow 画布纳入 EventBuffer；SSE 收敛为子系统内部实现 | 中 |
| 11 | workspace 工程 | `apps/*` 通配 + pnpm@10 锁定 + `onlyBuiltDependencies` 白名单 | React 18/zod 4/Nest 与主仓隔离；带 postinstall 的新依赖补白名单 | 中 |
| 12 | 文档治理 | `check-docs` 门禁 + 决策 ID 表 + §4.13 台账 | 本方案入图；各阶段落地时同提交更新台账 | 低 |

## 4. 合并方式（三选项）

- **A. 子模块独立运行（现状，已落地）**：主仓与 futureFlow 双栈各自跑，零耦合。flow 上游仍在 MVP 冲刺期的最优解——子模块指针跟随上游，零维护成本。
- **B. iframe 集成内嵌（推荐目标）**：主仓加 flow 模式骨架（P1）+ futureFlow 侧身份桥/去品牌/缝对接（P2–P5）；NestJS 网关与 Dify 栈作为**独立子系统**保留，不折叠进主仓进程。React 18 vs 19、Rsbuild vs Next 的双版本问题靠 iframe 天然隔离，反而安全。
- **C. 深度代码收编（远期可选）**：frontend 折叠进 `apps/web`、网关改写为 Fastify `features/flow/`、TypeORM 迁移翻译进 `supabase/migrations`。成本最高，且与「迁移单源」「插件形状」纪律的对接代价大；等上游稳定 + B 跑通后再评估。
- **架构主轴（B/C 共用）**：futureFlow 已有 FlowGram→Dify 中间转换层，把它正式化为**引擎 SPI**（create/publish/run/stream 四接口 + 多 Provider：Dify 适配器 / FlowGram runtime-js 轻量适配器）。画布协议稳定、引擎可插拔（Coze Studio 先例已验证该解耦），同时为桌面零 Docker 形态铺路。

## 5. 分阶段实施（PR 拓扑）

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P0 | 子模块挂载 + 本方案 + 决策登记 | `pnpm test:docs` + `node --test tests/workspace.test.mjs` |
| P0.5 | 章程与决策登记（已完成：AGENTS.md references 例外 + `DEC-10`…`DEC-13`）；上游补 MIT LICENSE 文件为对外规范建议，不阻塞 | 人工核对 |
| P1 | 主仓模式骨架（不碰上游）：kind 枚举 + DB 前向迁移 + `workbench-surface` flow 分支 + 穷举不变量测试 + AGENTS.md 不变量登记 + `/flow` 占位路由 | `apps/web` vitest（`workbench-surface.test.ts` 扩 flow 穷举）+ `pnpm typecheck` |
| P2 | 身份桥与内嵌：token 交换/postMessage 注入、按主仓 sub get-or-create 用户、关 bootstrap/开放注册、CORS 加外壳域名、去品牌 4 点、`--ff-*` 视觉令牌对齐 | 双栈本地联调（futureFlow `pnpm start`：3000/3001/8080/5001）+ GUI 冒烟 |
| P3 | 凭证缝（`DEC-12`）：内嵌态 BYOK 实例下发（`resolveCredentials` → Dify Provider 同步，独立 feature 服务）；独立态保留 `.env` 全局 key | 服务端单测（凭证不回显、脱敏）+ 联调 |
| P4 | 计量缝（`DEC-12`）：内嵌态接 credits/usage（`DEC-5`/`DEC-6`），flow run id 作幂等键，平台池余额门进 flow 执行入口；独立态保留自带 balance | 幂等重放/并发/退款回归测试 |
| P5 | 事件统一：`streamEventSchema` 加 `flowRun.*`，EventBuffer 纳管 flow 画布，断线 `lastSeq` 重放 | shared 契约测试 + WS 集成测试 |
| P6 | 部署形态（`DEC-11`）：自托管 Compose 加 dify profile（无头）；桌面承载按 §8.1 另行决策 | 空库全量重放 + Compose 健康检查 |
| P7 | （远期）深度收编评估 | 届时另立方案 |

纪律：每阶段一个可验证行为变化 + 测试护航；跨端契约（`packages/shared`）改动全量门禁；《改造计划》§4.13 台账同提交记账。

## 6. 许可证与合规

- **组合结论**：GPL-3.0 主仓 ⊃ MIT futureFlow（宽松→copyleft 单向兼容，可并入）；Dify（Apache 2.0 + 附加条款，source-available）以**独立容器 + API 通信**接入，属聚合（aggregation）而非衍生作品；**不得把 Dify Python 代码复制进本 monorepo**，保持容器边界，分发附其 LICENSE/NOTICE。
- **Dify 附加条款**：① 多租户限制——单用户/单 workspace 部署不触发；未来若做 SaaS 且 Dify 侧多 workspace，需书面商业授权。② logo/版权条款**仅约束 Dify 前端**——`DEC-11` 的无头部署（不跑 dify-web/nginx）明文不适用。
- **Dify 0.15.3 已 EOL**（2025-02 发布，主线已 1.14.x）：按 `DEC-13` 规划升级路径——固定 digest 起步 + 升级回归门禁（DSL 转换器对 0.15.3 行为有硬编码兼容，升级必须回归）；THIRD-PARTY-NOTICES 如实标注 source-available 属性。

## 7. 风险清单

| # | 风险 | 对策 |
| --- | --- | --- |
| 1 | 上游有 force-push 历史（2026-09-17 实测） | 子模块指针固定到具体 commit；升级指针时逐提交审阅 |
| 2 | 依赖未文档化的 Dify Console 私有 API（建应用/导入 DSL） | 网关已封装集成服务；Dify 升级前做兼容回归（`DEC-13` 门禁） |
| 3 | 前端巨型单文件组件（最大 2654 行）维护成本 | B 形态下作为子系统隔离；不鼓励主仓侧改其内部 |
| 4 | 网关进程内定时器/内存态限流，多副本会重复触发 | 自托管文档标注单副本约束；后续再评估分布式锁 |
| 5 | 测试体系非标准（自写脚本 + 真 Docker 栈），进不了主仓 CI | 保留为上游自检；主仓侧为集成缝写自己的回归测试 |
| 6 | 上游仓库无独立 LICENSE 文件（仅 README/package.json 声明 MIT） | 版权人即本仓协作者，并入无障碍；建议上游顺手补标准 MIT LICENSE 文件，便于未来外部贡献与第三方审计 |

## 8. 开放问题

1. **桌面 flow 引擎承载**：Dify 全家桶实测压缩镜像 ~1.7GB、磁盘 4–6GB、空载内存 1.5–3GB，与桌面预算（安装包 <150MB、内存 ≤900MB）差一个数量级，且 Tauri 壳是单子进程模型。候选：远程 Dify（用户自填地址 + Service API Key，对齐 BYON 原则）vs FlowGram runtime-js 轻量引擎（零 Docker、节点子集、官方自认早期）。需另立 FORM 决策，P6 前拍板。
2. **NestJS 网关长期去留**：B 形态下作为独立子系统长期存在，还是以 C 为目标提前做 Fastify 适配层？影响 P3/P4 缝的实现位置。
3. **上游协作模式**：作者继续在原仓开发、主仓子模块指针跟随；何时转入主仓直接开发（作者已是本仓协作者，随时可转）。
