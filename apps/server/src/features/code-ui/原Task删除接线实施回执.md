# 原 Task 删除接线实施回执

原 `zcode-task.deleteTask({taskId,workspacePath,workspaceIdentity?})` 已接到既有 Task 关闭与不可见服务。固定目录、可选 Project 与 qualified identity 全部校验；子会话不能冒充根 Task。没有修改原 ZCode wire 或 HTTP 路由契约。

删除关闭该 Task 的 Run/作用域/附件并保留墓碑；原列表及 GET/scope 不再可见，用户目录和 CLI/native 内容保留。重复已删除 Task 目前返回 404，并发另一请求可能 404/409；这是明确的当前行为，未宣称已与原 ZCode 的重复 void 成功完全一致。

## 实际证据

- `48093` 原公开 RPC 501 RED，接线后 `42854` 父删除、子独立再分叉与孙实际模型续跑 GREEN。
- `22484` 两条真实 HTTP/PG/Harness case 全部通过。错误固定目录、qualified identity、Project、另一项目 Task 均拒绝且不删除邻居；正确删除后列表消失/墓碑出现、原 native checkpoint 与用户文件保留。
- 并发删除恰一成功，只关闭所属模型流；邻居仍持有同一前台 Run 并自然完成。顺序重复与删除后迟到发送 404，模型请求不增加、墓碑不复活。

测试只使用独占临时数据库与随机回环端口；kernel/native 读取只强化公开删除保留原内容的证据，不生成业务事实。

提交前 `20857` 完整 `pnpm test` 16/16 通过（server 2016 实际通过，226 默认 skip 不计能力；其余 15 任务缓存）；`5681` 全类型 13/13 通过（server 实际、12 缓存）。首次全类型 `17603` 在测试 optional qualified identity 处失败，已保留必填返回类型修正。13 本域源码 Biome 与 3027 来源零漂移通过。

```sh
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/task-delete.integration.test.ts
pnpm test
pnpm typecheck
```

完整断线/响应丢失后的删除恢复链、持久资源准备及三平台原 GUI 验收继续留在总 Goal；本文不扩大为全部删除操作完成。
