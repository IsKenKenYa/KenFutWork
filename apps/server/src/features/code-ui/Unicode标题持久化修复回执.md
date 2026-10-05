# Code Unicode 标题持久化修复回执

2026-10-06；共享分支起始基线907946b2，CUA独立发布/验收提交330c1326与dc1c6eeb保留。当前阶段：真实公开回归已取得RED→GREEN，生产已修，最终类型/仓库门禁与独立提交收尾中；不计完整Code或实际包内TCC完成。

## 已核实失败与落点

CUA实际.app用例46443调用原sendText，正文为`观察第一方验收窗口，截屏并输入Task中文🙂🚀。`，收到500/code_ui_error/invalid input syntax for type json。其独占PG日志明确为`Unicode low surrogate must follow a high surrogate`，失败语句为`update public.code_ui_sessions set state=$2::jsonb`，JSON片段尾部包含`Task中文🙂\ud83d`。已读回该日志，不把TCC denied或测试命令误用当作此产品错误。

`features/chat/session-title.ts`的deriveSessionTitle剥指令块后按UTF-16调用slice(0,24)。上述正文恰为24个Unicode码点/26个UTF-16码元，切口落在🚀的高代理项。生产唯一消费者是Code conversation.startRun生成meta.title，再由原repository把Task状态写入JSONB；没有发现可复用的标题Unicode安全截断。

## 公共回归与修复语义

新增title-unicode.integration.test.ts，复用已跟踪的真实HTTP/本机cookie/隔离PG/原Project与Task/Harness/native及无工具heldModel SSE夹具，只控制外部模型回复。原文本sendText须accepted，标题保留24个完整Unicode码点，canonical/原userInput/实际模型请求/native Human正文必须原样；同commandId重放不能新增输入/模型/Run，模型finish后须真实completedSuccess并关闭SSE，目录/Actor/两代际不变。

修改既有deriveSessionTitle，继续剥首部指令与空标题回落，仅将24字前缀按Unicode码点迭代；最多收集24个完整码点，不再按UTF-16码元切片或为标题另建全量码点数组。原用户正文不改，不改原ZCode UI/协议或另建Task入口。保留既有ASCII/指令块回归；标题展示预算仍为原24字，不是Agent运行时治理上限。既有stripLeadingDirectiveBlocks的实现与行为未改，本片不声称整个指令解析的复杂度有新上界。

## 实际证据

- CUA94168实际TCC denied及其请求人类授权后，正式确认全部app/Node/PG/检查句柄已退出并交回窗口；固定供授权副本留存、不启动或重签。主线程78252新HTTP/RPC/独占PG case实际exit1，在合法原正文sendText的200期待得到500/code_ui_error/invalid JSON，复现同一产品缺陷；失败记录未删。
- 修原函数后22982首case实际exit0：标题为完整24码点原句，canonical/userInput/模型请求/native Human正文原样，原commandId duplicate重放不增加输入/Run/请求，原SSE自然关闭并completedSuccess，目录/Actor/两代际不变。
- GREEN后按接纳观察、自然完成读回、顺序清理拆分测试职责，增加独立长正文`abcdefghijklmnopqrstuvw🚀尾部中文🙂保留在正文`，标题只保留`abcdefghijklmnopqrstuvw🚀`，全部尾部正文仍进入原模型与native。79128两条真实case及旧ASCII/指令块8条共10实际通过；第二case首跑GREEN，不伪称它有独立RED。
- 96833完整server实际exit0：231文件、2010条通过，82文件/201条默认skip不计能力验收；两个Unicode gate已另显式通过，mode RPC gate尚未实测。
- 61492全类型实际exit0：13/13任务成功、12内容缓存/server实际执行；398a29仓库/API25条实际exit0；8a46ee两owned源Biome实际exit0，无error/warning。本片三路径与自己的日志段独立提交；mode RPC新test与两个CUA新提交均不吸收。

```sh
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/title-unicode.integration.test.ts --maxWorkers=1 --no-file-parallelism
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/title-unicode.integration.test.ts src/features/chat/session-title.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @kenfutwork/server exec vitest run --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm test:workspace
pnpm exec biome check apps/server/src/features/chat/session-title.ts apps/server/src/features/code-ui/title-unicode.integration.test.ts
```

本片没有启动第二检查实例、操作桌面或改变系统权限；新代码未替换固定TCC授权副本的旧server bundle，实际.app初始emoji指令须后续刷新打包再验，不能拿源码真实GREEN冒称包内通过。模式RPC的plan-mode-scope候选仍尚未执行，此公共输入阻断独立提交后恢复原RPC纵向片。Code完整Goal继续active，不能以本片替代全部Unicode/媒体、规划、GUI/Design或三平台验收。
