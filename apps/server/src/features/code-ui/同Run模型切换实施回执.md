# 同Run模型切换实施回执

2026-10-05；主checkout `codex/完整移植ZCode-Code界面`，本批按冻结模型切换独立交付。完整Code目标继续，不以文本切模型替代mode/plan、媒体、子代理或压缩组合验收。

## 已接通的行为

忙时纯文本guide可携带另一份已通过原ModelSelection资格并由服务端编译的冻结模型执行快照；同mode/plan的A→B在同一Run下一模型请求切换，不退回另一个Run。原A/B canonical输入、Actor、Task、目录、作用域与分支两代际保持；原V4配置更新到已消费选择。

Definition为SDK扩展缝的 `AgentRunModelControl`，Provider为 `agent/model-execution.ts` 的冻结解析和单Run当前模型，Consumer为Code guide middleware与共同native模型请求入口。没有新增ctx key、wire DTO、独立Agent loop或第二份供应商库存。起始Run与切换共用协议适配器、可信Actor和会话头渲染；目录校验与冻结provider/model/configRevision失败显式报错，不将目录服务失败当成校验成功。

guide的beforeModel只登记冻结选择并返回稳定HumanMessage。真实解析在native消息提交后的请求入口；SDK默认summarization位于novel插件之前，所以在该共用入口统一采用当前模型，再进入已有summary/tool中间件。每个新模型句柄携带服务器签发的安全调用归属，原Run/model起点不改，usage继续按实际SDK call ID分别落桶。

当前模型能力对象与未来文件/子任务的modelSpecifier消费者已经接线，压缩trigger/keep引用随选择更新；代码能力对象从冻结快照复制，不能反向改写A的输入能力。该部分尚需B实际媒体Read、子代理继承及自动压缩阈值/摘要模型的组合tracer，不能由普通文本切换证明全部。

## 真实证据

- 5007 exit1只暴露测试重放ACK误期待accepted；原契约为duplicate并保留原结果，已修三个阶段断言，不记业务RED。
- `/private/tmp/kfw-guide-model-product-red.log`，31194 exit1：B已通过真实原view资格、实际prepareInputModel并持久冻结；A结束后的实际HTTP选择B，却另起Run，明确功能RED。
- `kfw-guide-model-green-first.log`，52768 exit0：同Run实际A/B请求、冻结输入与native两AI usage、公开summary和真实PG按模型分桶A10/3、B20/7；原V4累计30/10。重复command在A/B/结束后均不新增请求。
- `kfw-guide-model-config-failure.log`，65888 exit0，2条：B accepted后通过原RPC修改providerName，公开配置修订及真实config_revision均上升。消费后原Run可读配置错误、guided B/native HumanB仍保存、未来队列暂停，B零请求，不暗用A或新建Run；仅A10/3落账。
- `RUN_CODE_UI_INTEGRATION=1 KENFUTWORK_HARNESS_TEST_PG=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/guide-model.integration.test.ts src/features/code-ui/guide-text.integration.test.ts src/features/code-ui/guide.integration.test.ts src/features/code-ui/model-usage.integration.test.ts src/features/agent-runs/manual-model-usage.integration.test.ts src/features/code-ui/manual-compact-v4.integration.test.ts --maxWorkers=1 --no-file-parallelism`：`kfw-guide-model-real-cross-gate.log`，53316 exit0，6文件9条通过；含FIFO、问答工具、停止、usage及真实手动summary恢复。
- 现有header/历史/计量/SDK工具消费者6文件29条通过、2无关skip：`kfw-guide-model-scoped-authorized.log`，60677 exit0。默认沙箱的35212因回环listen EPERM失败，不计业务回归。
- `pnpm --filter @kenfutwork/server test`：`kfw-guide-model-server-gate.log`，13219 exit0，228文件2001条通过、185默认skip不计验收。
- 4706 types实际exit1（新增可选字段赋值）；修后97974 server types exit0。最新32145完整server types实际exit1，仅并行CUA新native test的StreamableHTTP Transport.sessionId exactOptional类型不匹配，已交属主修复，不能记全仓绿色。当前模型源未报新TS错误。CUA随后修复其SDK transport桥；最新 `kfw-guide-model-final-types-2.log`，29479实际exit0，完整server types已通过。

最后能力对象复制后再次运行原2条实际模型/配置失效case：`kfw-guide-model-final-behavior.log`，91498 exit0。`pnpm test:workspace`：`kfw-guide-model-workspace-gate.log`，b3185f exit0，仓库/API/文档25条通过。

## 剩余范围

本批只允许同mode/plan、纯文本模型切换。显式mode/plan、独立guide pre/history、权威工时、媒体能力变化、后续子代理/自动summary实际继承、权限/关闭并发边界、原GUI/视觉/Design与三平台完整交付继续待完成。已有guided根输入重试守卫保留，不能用A的pre丢掉B。

无新增HTTP或WS schema；原V4契约保持。共享MCP/HTTP/governance/API及其native tests为并行Computer Use所有，提交不得整文件或整树吸入。
