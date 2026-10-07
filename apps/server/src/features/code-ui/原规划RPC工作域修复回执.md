# 原规划模式 RPC 工作域修复回执

2026-10-06；共享分支基线f73c08fb。只收口既有Task的switchCollaborationMode原plan入口；新Task创建、history edit/retry仍下一独立片，不宣称所有原plan消费者完成。

## 权威语义与生产修改

消费已移植原@zcode/shared.resolveExecutionState：原wire mode=plan保持当前规范基础mode、开启独立planEnabled。继续沿原命令指纹、持久认领、Task根锁和ACK回执，在根锁内解析当前config；原writeState在同一锁内按bit实际改变推进planningEpoch。

raw plan完全跳过executionScopes.updateTask，不把规划flag反推physical read-only，也不先归一成当前yolo再反向扩大为danger-full-access。主/附加目录、Actor、scopeGeneration/branchGeneration和已运行句柄保持；工具目录、逐调用权限与规划提示继续消费同一effective plan只读夹紧。明确非plan base选择的现有OS预设映射本片保留，不将这片称为全部权限模式/OS轴分离。

## 真正RED与GREEN

- 5343真HTTP/RPC/独占PG/Harness/外部模型SSE：idle原yolo→真实Scope PATCH收窄read-only→真实A持流→raw plan RPC accepted。在A.finish/真实Enter之前公开snapshot要求yolo/true，却返回plan/true，实际exit1。其余前置成立，非数据库/模型或cleanup先决故障；原physical已readonly使旧updateTask恰noop。
- 按上述原resolver与rawplan物理noop接线后68923同case实际exit0：基础yolo/规划true、fresh GET Scope深等、目录/Actor/两代际/原Run/A输入与模型冻结不变、A仍持流；后续真实Enter幂等、B恶意原Write正式拒绝、C同Run自然结束，native/PG/V4与三段SSE关闭。不是只凭accepted或原工具广告。
- 37477六文件9条显式真实cross全部exit0，涵盖Scope RPC/独立Plan开关/原plan别名guide/模式折返/Enter/Unicode；74470 server types实际exit0。
- GREEN后按idle选择/Scope建立/实际模型边界拆分准备职责，保留read-only全部事实；增加危险全访问的可写Scope，不发Readonly PATCH，A实际广告Write。9078最终两case实际exit0；可写case的rawplan不收窄或撤销physical、不关闭A，planningEpoch恰增一代。固定原commandId/raw payload/guard，两次真实顺序重放均duplicate且其它ACK与PG唯一receipt/fingerprint不变、epoch不再增加，再真实Enter幂等/Writeerror/自然完成，工具完成事实精确一次。第二case首跑GREEN，不伪称独立RED。

原命令指纹只含sessionId/type/payload，issuedAt和guard不入指纹；重放仅覆盖已接受命令的顺序duplicate与无新效果，不声称旧guard被CAS拒绝、并发pending恢复或完整删除后重放已验。

```sh
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/plan-mode-scope.integration.test.ts --maxWorkers=1 --no-file-parallelism
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/plan-mode-scope.integration.test.ts src/features/code-ui/plan-state.integration.test.ts src/features/code-ui/plan-alias.integration.test.ts src/features/code-ui/guide-mode.integration.test.ts src/features/code-ui/enter-plan.integration.test.ts src/features/code-ui/title-unicode.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

## 当前收尾与边界

最终完整server 33692实际exit0：231文件/2010条通过，82文件/202条默认skip不计能力验收；两条Scope case已由9078另显式通过。48821全类型实际exit0，13/13任务成功（12内容缓存/server实际）；0489cc仓库/API25条与9b8425本域test Biome实际exit0。整份service仍为此前HEAD已有的import整理/格式两类错误，5cef62 exit1未冒称GREEN，未整文件格式化。生产只有service.switchMode一个行为片，新test实际消费已跟踪helpers及原enter外部模型，没有新Harness/DTO或fixture替写ToolMessage。按本域service/test/回执与自己的日志hunk独立提交。

CUA的d16848c8/330c1326/dc1c6eeb及本域Unicode f73c08fb都保留。固定TCC副本不启动/重签，待人类系统权限；源码真实Scope/Unicode不替代实际.app、原完整GUI/Design或三平台验收。完整Goal继续active，主子规划/冷恢复/删除分支/自动压缩与模型媒体等仍继续。
