# 独立Plan开关实施回执

2026-10-05；主checkout `codex/完整移植ZCode-Code界面`，基线c0aa9f59。本批只接独立规划boolean的真实执行消费者，Enter/ExitPlanMode、退出批准、批准文件和压缩连续性仍待实施。

## 真实行为与接线

Task的原canonical输入与原V4配置各自保存基础 `mode` 和 `planEnabled`；消费guide或启动输入不再把基础mode改成plan。忙时纯文本guide可改变flag，接收时不提前改当前配置，下一模型边界FIFO消费仍沿同一个Run。

Definition复用私有 `codeApproval.resolve` 与PromptCompositionContext；Provider是agent-runs插件按当前真实Task读取原mode与boolean，按原schema严格解析，缺字段按false。flag开启时仅派生本次有效plan权限，Task基础配置不改；Consumer为既有registry/权限/目录执行链，以及runtime初始提示和ToolCatalogue每请求重组的提示。没有第二份持久权限、第二Agent loop、新ctx key或HTTP/WS契约。

现有kernel最终claim已会将审批起点或最终plan夹为只读，main子派发使用approvedExecutionMode固定子任务ceiling；这次不复制另一份PermissionInvocation或子任务许可。规划提示明确开/关，开启时先只读调查和形成方案，不提尚未注册的Exit工具。

只复用已有外部cycle模型脚本与真实HTTP/隔离PG/LocalActor/Task/Harness/FS。公共读取、顺序释放和native工具事实helper从原mode test移出到无测试注册副作用的fixture；原两条mode场景保留，不另抄内部policy、ToolMessage或模型服务器。

## 已取得的证据

- 9446实际exit1，`/private/tmp/kfw-plan-flag-product-red.log`：flagtrue指引持久化成queue/notRequested并分配另一Run。原mode两条仍GREEN，明确新行为RED。
- 32492实际exit0，`kfw-plan-flag-green-first.log`：两文件三条真实场景通过。A原RPC切yolo且物理scope可写；flagtrue的B raw config/canonical保持yolo，实际有效plan/Write隐藏；B held时false指引只queued，B原Write正式error、磁盘无文件；C边界才恢复false和Write，原路径新call真实写入，D同Run自然完成。
- guide输入/native稳定ID各一次，原A冻结canonical/模型选择不改，Task/目录/主与附加授权/两项代际保持，V4/PG/native分别有真实error/success，所有SSE关闭。
- 42407全量 `pnpm typecheck` 实际exit0：13/13任务成功、9缓存。新fixture/test与两个本批生产文件默认Biome检查exit0；其余已有全文件格式债务仍按范围保留。
- 82942实际exit0，`kfw-plan-flag-real-cross-gate.log`：8文件12条真实HTTP/PG交叉通过，包含本flag、原mode、冻结模型及配置失效、FIFO、问答/停止、usage、真实手动summary恢复；不是只核对ACK或消息库存。
- 14938实际exit0，`kfw-plan-flag-full-tests.log`：串行全包16/16任务成功、11缓存；shared111/server2001/Web457通过，仓库/API/文档25条通过。此时server189默认skip不计能力证据。
- 随后只增加冷起点场景及共用helper API：94110实际exit0，`kfw-plan-flag-final-behavior.log`，两文件4条通过。初始A即yolo/true，实际提示有效plan/ceil plan/规划开启且无Write；同flag文本guide让B/C仍在原Run，B真Write被拒，C自然结束；raw配置/canonical不折叠为plan，Task目录/两代际不变，native/PG/V4与实盘拒绝一致，三SSE释放。无额外生产变更，未把原4段关闭/恢复场景替代为较易的只读测试。

可复制的真实验证命令：

```sh
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/plan-state.integration.test.ts src/features/code-ui/guide-mode.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

以上为实际已运行证据；全包门禁之后的测试变更由更强的4条显式真实场景再验，冷起点后的最终类型/文档门禁在提交前按实际终态追加，不推断结果。

冷起点后最终 `pnpm typecheck`：43477实际exit0，13/13成功、12缓存（server实际执行）；五只本批fixture/test/生产文件默认Biome检查exit0、无修改。其余源只改逐hunk所需内容，已有全文件formatter/import漂移不批量改。日志及规格修改后仓库/API/文档门禁另行实际复核。

## 仍待接通

完整Plan需要有限的可信控制effect，复用原broker和原Plan Elicitation，Exit即使yolo也须明确approve；AskUserQuestion的宽松accept/freeText推断不能作为批准。已批准计划需独立Task事实和管理文件相对引用，snapshot.plan继续是Todo进度。管理根来自LocalInstance/dataDir，不能为了计划把整棵数据根加入Task授权目录。

旧 `mode=plan` 输入兼容/Scope RPC的归一化、Plan控制取消/重放/撤权/冷恢复、子任务规划提示与批准计划在compact后的真实消费继续待完成。模型媒体/子任务/摘要组合、guided独立pre/history/权威工时、原GUI/视觉/Design与三平台也继续在完整Goal范围，不由本boolean叶替代。

CUA/HTTP/MCP/shared/API/依赖修改属于并行线程，不混入本批提交。其HTTP transport的nullable id修复与原case/类型终态已独立核对；不把别域skip或源码存在当作平台能力完成。
