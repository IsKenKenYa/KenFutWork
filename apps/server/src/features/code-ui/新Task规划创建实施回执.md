# 新 Task 原规划别名创建实施回执

2026-10-06；共享分支基线f7ab52d4。只收口createSession创建边界；history edit/retry的物理Scope消费者尚未修，不宣称所有原plan入口完成。

## 实现与权威语义

createAdmittedSession消费已移植原@zcode/shared.resolveExecutionState，以无current的原默认build/false解释raw config，显式planEnabled优先。raw mode=plan缺flag→build/true；raw plan+false→build/false。规范状态在创建Task与初始快照前一次固定，不能让首次sendText的接纳规范化掩盖错误创建。

新Task物理Scope仅按规范基础mode的既有预设创建：build/edit为workspace-write、yolo为danger-full-access；规划flag不反推read-only。主/附加目录仍从服务端Project持有并固定到Task，真实Task/Actor/run身份保持。没有第二DTO、假Actor或从Canvas/路径猜Task。

既有host-session.fixture仅新增从原CommandPayloadMap派生的可选initialConfig(mode/planEnabled)并透传原create payload，保留modelSelection选择和默认创建行为。新增ACK accepted断言；没有override任何自家服务或复制Harness。新test消费原enterPlanFixture三段模型SSE，控制工具与Write错误仍由正式管线生成。

## 实际RED与GREEN

- 71628新真实HTTP/RPC/独占PG case实际exit1，在create ACK后且sendText前V4要求build/true，原实现却plan/false；物理readonly缺口也在原源码上明确。此失败不是后续模型或工具前置。
- 原resolver接线后24752首次尝试仅卡测试错误的branch初代0期待。权威20261002202429_code_checkpoints_task_scope.sql规定DEFAULT 1、CHECK >=1；只修test两处为1，不改生产/历史SQL或其SHA。失败记录保留，不把该断言误记为新产品RED。
- 68540原缺flag创建case实际GREEN：create时build/true，fresh GET Scope workspace-write/scope0/branch1，真实Task/Project/Actor及主目录/noRun/noInput成立。首sendText不送mode/flag，canonical固定build/true；已true的原Enter幂等且epoch不变，B/C同Run有效plan/ceiling plan、实际原Write拒绝、C自然completedSuccess，native/PG/V4事实一次、三SSE闭合，Scope/两代际保持。
- 44915六文件9条显式真实交叉全部exit0，覆盖创建/已存在Scope RPC/原别名guide/独立Plan/Enter/Unicode。
- GREEN后追加独立显式false创建case并共用准备/稳定/事实/顺序清理。80933最终两条实际exit0：第二create为build/false及workspace-write，A真实build/build且广告Enter/Write；原Enter后config build/true、epoch恰+1，原canonical false与Scope/Task/Actor/两代际保持，B/C有效plan/ceiling build、原Writeerror后自然结束。原策略build写为ask、目录只过滤deny；没有滥用只支持yolo/plan的旧测试helper。第二case首GREEN不伪称独立RED。

```sh
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/plan-create.integration.test.ts --maxWorkers=1 --no-file-parallelism
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/plan-create.integration.test.ts src/features/code-ui/plan-mode-scope.integration.test.ts src/features/code-ui/plan-alias.integration.test.ts src/features/code-ui/plan-state.integration.test.ts src/features/code-ui/enter-plan.integration.test.ts src/features/code-ui/title-unicode.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

## 最终门禁与剩余项

完整server 56370实际exit0：231文件/2010条通过，83文件/204条默认skip不计能力；两条新创建case已由80933另显式通过。44500全类型13/13实际exit0（12内容缓存/server实际执行）；4b8e65仓库/API25条与324afa两个本域fixture/test Biome实际exit0。整份service仍有HEAD已有的import/格式两类问题，a1a1f8 exit1未称GREEN，未整文件格式化。service本域创建hunk、fixture/test与此回执及自己的日志段按功能独立提交，保留此前Unicode/Scope RPC/CUA提交。

本片未覆盖所有base/显式true组合、并发创建与删除后重放/冷恢复。既有创建幂等键/指纹/原事务没有改，不用本片两个case冒称全部幂等边界。固定TCC授权副本不启动/重签，尚待人类；源码路径不替代实际.app或原完整GUI/Design/三平台验收。完整Goal继续active，下一片处理history retry物理Scope反推，自动压缩与模型匹配等窄源审缺口仍保留。
