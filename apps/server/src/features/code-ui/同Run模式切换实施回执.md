# 同Run模式切换实施回执

2026-10-05；主checkout `codex/完整移植ZCode-Code界面`。本批接通普通纯文本guide的权限mode变化；独立 `planEnabled` 工作流仍待实施。

## 已接通行为与边界

普通 `sendText` 在原 `followupMode=guide` 下可携带另一权限mode。接收时保留冻结canonical输入，当前模型请求不变；下一模型边界按FIFO消费，在原Task事务中更新原V4配置，并由既有实时权限解析、提示注册表、工具目录与执行门消费。没有新Run、第二Agent loop、Canvas、目录变更或授权代际变更。

guide不能扩张Task已有目录/沙箱或子代理派发上限；恢复较宽mode仍受原作用域约束。改变Task物理授权继续通过原受守卫的Scope RPC，而不是模型文字或guide payload。

本切片显式保持 `planEnabled=false`，证明现行KFW的 `mode=plan` 只读权限档；不将其解释为已完成原ZCode的独立规划状态、Enter/ExitPlanMode批准、计划文件或压缩恢复。不同规划boolean暂仍按未来queue处理。

实际A先通过原 `switchCollaborationMode(yolo)` 更新Task沙箱，再冻结目录和两项代际。A真实模型提示/工具列表必须具有yolo与Write，新文件原本不存在。guide切plan后B/C的真实提示保留派发上限yolo、当前模式变为plan，Write不再曝光。外部B仍发合法Write调用，正式目录中间件返回带当前模式/权限原因的error ToolMessage，C同Run读取该结果并自然结束，文件始终未创建。

该拒绝暴露了既有生命周期顺序问题：ToolCatalogue的提前返回位于canonical观察者之外，native有error而原V4/持久工具事实缺失。现按已有 `canonicalToolEvents` 声明将观察者置于扩展外层，包住目录/权限的提前返回；主/子agent沿同一排序，无插件名判断或第二份工具事件实现。原call ID、native error、持久 `tool.completed/status=error` 与V4工具行一致。

## 真实RED与GREEN

- 25689 exit1（`/private/tmp/kfw-guide-mode-product-red.log`）为夹具错误：`setFollowupMode`缺少原revision guard，不计业务RED；已补守卫及accepted断言。
- 57741 exit1（`kfw-guide-mode-product-red-2.log`）：实际B另起Run，mode guide被回落队列，业务RED。
- 17730 exit1（`kfw-guide-mode-green-first.log`）：同Run、plan提示、Write隐藏和拒绝已到达，但原错误只写“角色不可用”，未给当前模式/权限原因。补可读错误。
- 47027 exit1（`kfw-guide-mode-green-2.log`）：C已收到正式error，文件不存在，但V4没有Write工具行。修正既有生命周期扩展顺序。
- 59475 exit0（`kfw-guide-mode-green-3.log`）：完整一条真实HTTP/SSE/隔离PG/LocalActor/Task/Harness/native/V4/磁盘链通过；A/B/C三次同模型、同Run，stable guide HumanMessage一次，原A冻结意图与模型执行快照不变，Task根与两代际保持，全部SSE自然释放。
- 65494 exit0（`kfw-guide-mode-real-cross-gate.log`）：10文件14条交叉通过，包含当前mode、冻结模型/失效、FIFO、工具/停止、usage、真实手动summary及工具生命周期。
- 43396 exit0（`kfw-guide-mode-cycle-real.log`）：原拒绝与新增折返回归两条通过。B仍held时第二条yolo guide仅入未来队列，B Write仍按plan拒绝；C模型边界才恢复yolo，在同一路径用新call ID真实成功创建文件，D同Run读取实际成功ToolMessage并自然结束。V4/PG分别error/success，两个guide native ID各一次，A冻结canonical、原Task目录/两代际不变，四条SSE全部关闭。
- GREEN后整理测试职责，保留全部原断言、脚本与逐次资源关闭顺序；提取准备/结束检查与共享fixture消费者，避免两个场景堆成大回调。69007 exit0（`kfw-guide-mode-final-behavior.log`）：最终原两条真实场景再次通过。

可复制命令（真实回环夹具需宿主监听权限）：

```sh
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/guide-mode.integration.test.ts --maxWorkers=1 --no-file-parallelism
RUN_CODE_UI_INTEGRATION=1 KENFUTWORK_HARNESS_TEST_PG=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/guide-mode.integration.test.ts src/features/code-ui/guide-model.integration.test.ts src/features/code-ui/guide-text.integration.test.ts src/features/code-ui/guide.integration.test.ts src/features/code-ui/model-usage.integration.test.ts src/features/agent-runs/manual-model-usage.integration.test.ts src/features/code-ui/manual-compact-v4.integration.test.ts src/features/code-ui/tool-lifecycle.test.ts src/features/tool-catalog/sdk.test.ts src/features/tool-catalog/catalogue.test.ts --maxWorkers=1 --no-file-parallelism
```

本机锁屏引起xcode-select文件边界捕获告警；本批验证native上下文、工具拒绝与实盘结果，不以该结果声明文件回退或GUI视觉通过。

## 门禁与剩余范围

首次全量 `pnpm typecheck`：22012实际exit1，仅并行Computer Use域 `src/http/computer-use-mcp.ts:206` 的RequestId可选类型错误；已通知属主，不能记全仓绿色。

首次全量串行测试 `pnpm test:workspace && pnpm exec turbo run test --concurrency=1`：57319实际exit1；仓库/API/文档25条、shared111条及server2001条通过，13任务成功。并行Computer Use新HTTP integration在Run停止后的会话仍409而期望404（该用例214行），已交属主修复并收口默认integration开关，186条skip不计验收；不改其测试或HTTP hunk。随后按最终源码复核，不能将这次全量失败改记成功。

属主静态修复RequestId后，26872全量types实际exit0、13/13任务成功（10缓存）。新增cycle后的26251此前仍只报该HTTP错误，保留其失败记录。Computer Use真实停止清理仍需属主显式用例证据，默认gate跳过不计该能力成功。

最终主树门禁：

- `pnpm test:workspace && pnpm exec turbo run test --concurrency=1`：99790实际exit0，仓库/API/文档25条通过；全包16/16任务成功（13缓存），server2001条、Web457条、shared111条通过。server188默认skip不计能力验收；Computer Use显式HTTP gate已由属主实际落主树，本批不宣称其停止清理已通过。
- 整理测试后的 `pnpm typecheck`：74267实际exit0，13/13成功（12缓存，server本轮实际执行）；`kfw-guide-mode-final-types-post-review.log`。
- 两个新test/fixture默认Biome检查退出0、无修改；四个生产源仅关闭已有全文件formatter/import-assist漂移后语义lint退出0，86条既有警告保留。未做原ZCode或无关源码的批量格式化，未宣称全仓lint无债务。

本批提交仅包含四个生产落点、两只测试/夹具、此回执与自己的日志段；共同日志用基于HEAD的过滤补丁暂存，其他域hunk保留。没有新增引用尚未入库的实现文件。

完整目标仍包括独立规划boolean与真实Plan批准/文件/压缩消费者、guided独立pre/history与权威工时、切模型媒体/子任务/自动summary组合、权限恢复/子代理停止、原GUI/视觉/Design与三平台交付。此叶通过不代表完整Code改造或原UI验收完成。

无新增HTTP/WS契约；原ZCode UI字节保持。并行Computer Use/HTTP/MCP/shared/API/依赖变更不属于本批提交。
