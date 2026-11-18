# MCP HTTP 取消关联清理修复

固定包：官方 npm `@modelcontextprotocol/sdk@1.32.1`，MIT（首发补丁切在 1.30.0，见下「历史」段）。原包与安装目录 ESM/CJS 字节一致；没有虚构上游 Git SHA。

## 范围

原 Protocol 取消处理器会中止 handler 并抑制响应。公开 `closeSSEStream` 关闭 SSE 后，原 transport 仍保留请求关联；无 eventStore 时不会重放，重复取消会累积关联。候选补丁清理无 eventStore 的已关闭 POST 所属关联，保留有 eventStore 时的重连关联；会话 close 时清空全部关联。

ESM/CJS 两个发行入口同步修改，不在业务代码中读取或写入 SDK 私有映射，不改 Protocol、会话身份或新建事件存储。发行 source map 保持上游版本，补丁后的行号不反映在原 map 中。原许可保存在 `MCP原始许可证.txt`；升级 SDK 时先复验公开取消、响应体结束和重连关联语义，再退役或重建补丁。

## 升级到 1.32.1 的复验（2026-10-17）

Dependabot #43（high，GHSA：OAuth 客户端可把凭据发往 MCP 服务端自选的授权服务器）在 1.31.0 修复，直接升到 1.x 最新 1.32.1。1.31.0 与 1.32.1 的 `webStandardStreamableHttp.js` 字节相同，补丁内容与目标版本无关。

升级前逐处复验补丁语义：1.32.1 的 `close()` 仍只清 `_streamMapping`/`_requestResponseMap`/`_resumableStreams`，**没有**清 `_requestToStreamMapping`；`closeSSEStream()` 仍只做 `stream.cleanup()`。上游在 `send()` 里新增了几处兜底释放（`_closed` 分支、无 resumability 时释放关联），方向与本补丁一致但不覆盖取消路径，所以两处改动仍然必要，按原语义原样重切。ESM/CJS 两处锚点在 1.32.1 各只命中一次，重切用精确串替换而不是行号补丁。

行为变化一处：客户端 transport 新增 `redirectPolicy`，默认 `'same-origin'`——跨源重定向不再跟随并直接失败（这正是修复本身）。BYOK 下若用户配的 MCP 网关靠跨源重定向落地，连接会显式报错，需要用户改用直连地址或显式设 `'follow'`。

`pnpm.overrides` 加一条把 `<1.32.1` 全部钉到 1.32.1：`shadcn@4.21.0` 自带 `^1.26.0` 会解析出第二份 1.30.0，不钉住则告警不会随 lock 消失。许可证 SHA 在新版本不变，`MCP原始许可证.txt` 无需重取。

## 来源 SHA-256

当前发行（1.32.1，补丁名 `@modelcontextprotocol__sdk@1.32.1.patch`）：

- `dist/esm/server/webStandardStreamableHttp.js` 原 SHA `8ac6b6a32299f840377721c55ba4b938dd90158a415c8ccf09ce3cdda131897d`；补丁后 SHA `1eafe082307ec308c266ecd91d2c1f9a357ad3efcce69829f5c0d17b62289261`。
- `dist/cjs/server/webStandardStreamableHttp.js` 原 SHA `aab0e9c79d398fd1e541d166c46f1893f6e6562fd7b36f3c6c5e5521a2382a0a`；补丁后 SHA `5abd64e55e635371fce0fac6dc4b0480ee224fe8e6417c095060b6dd3d1d96b6`。

历史（1.30.0 首发补丁，已随升级退役）：

- `dist/esm/server/webStandardStreamableHttp.js` 原 SHA `7f13981326b31e78ae7c66406e2961176c2619bb1b2f6b6e4b99ac78e90f1d8c`；候选 SHA `049338abc909b469cda43e9fce69234a792ef7b647d4d886b71ead945b2ca9fa`。
- `dist/cjs/server/webStandardStreamableHttp.js` 原 SHA `51f0bb018442341032d7d5897e204ce48a65cbe5df14db03083fa07e3ca325c1`；候选 SHA `426712eb6c71ad0a0dd9de4d4c97b2210c77551a730c68e98fe1409b520ad60a`。

## 验证

- 原包实际 RED：`/private/tmp/kfw-cu-sdk-cleanup-red.log`，144d75 exit1；无 eventStore 取消后残留1条关联，有 eventStore 会话 close 后残留3条关联。
- 首次 `pnpm patch-commit` 仅登记而未刷新安装/锁文件，原 RED 仍失败；保留该失败。随后 `pnpm install --offline --no-frozen-lockfile --ignore-scripts` 实际应用补丁，既有 LangChain patch hash 保持不变。
- `pnpm --filter @kenfutwork/server exec vitest run src/features/mcp/sdk-transport.test.ts --maxWorkers=1 --no-file-parallelism` 实际 GREEN：`/private/tmp/kfw-cu-sdk-cleanup-both-green.log`，22644 exit0，ESM/CJS×有/无eventStore共4条；每条重复取消3次，确认原POST body结束，无eventStore逐请求释放，有eventStore保留到会话close后释放。
- 明确开启的真实HTTP/PG/Task/Agent/stdio回归：`/private/tmp/kfw-cu-http-lifecycle-green.log`，91734 exit0，跨POST取消、跨session隔离、DELETE重放拒绝、实际撤权与Run停止取消在途调用；响应可被抑制或保留原cancelled结果，不能把actionSent=true误判成操作成功。
- Computer Use/MCP定向129条通过、10条默认跳过；shared115条、全类型13/13任务（9缓存）及仓库/API25条通过（71818 exit0）。不重跑全量pnpm test，默认skip不计OS能力。

2026-10-17 重切后：

- 1.32.1 摘掉补丁先跑一次实际 RED：`src/features/mcp/sdk-transport.test.ts` 4/4 失败（无 eventStore 取消后残留 1 条、有 eventStore 会话 close 后 `_requestToStreamMapping.size` 期望 0 实际 3，ESM/CJS 各一条）。
- 重切并 `pnpm install --no-frozen-lockfile --ignore-scripts` 后同一命令实际 GREEN：4 passed，exit0。安装目录 ESM/CJS 两处补丁文本均已落地（`node_modules/.pnpm/@modelcontextprotocol+sdk@1_ad42…`）。


真实 HTTP/PG/Task/Agent/stdio 取消、撤权与 Run 停止验证属于协议证明。macOS HTTP 原生取消和最终签名 .app/TCC/安装验收另行完成；锁屏时不运行输入测试。
