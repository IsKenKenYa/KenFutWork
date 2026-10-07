# MCP HTTP 取消关联清理修复

固定包：官方 npm `@modelcontextprotocol/sdk@1.30.0`，MIT。原包与安装目录 ESM/CJS 字节一致；没有虚构上游 Git SHA。

## 范围

原 Protocol 取消处理器会中止 handler 并抑制响应。公开 `closeSSEStream` 关闭 SSE 后，原 transport 仍保留请求关联；无 eventStore 时不会重放，重复取消会累积关联。候选补丁清理无 eventStore 的已关闭 POST 所属关联，保留有 eventStore 时的重连关联；会话 close 时清空全部关联。

ESM/CJS 两个发行入口同步修改，不在业务代码中读取或写入 SDK 私有映射，不改 Protocol、会话身份或新建事件存储。发行 source map 保持上游版本，补丁后的行号不反映在原 map 中。原许可保存在 `MCP原始许可证.txt`；升级 SDK 时先复验公开取消、响应体结束和重连关联语义，再退役或重建补丁。

## 来源 SHA-256

- `dist/esm/server/webStandardStreamableHttp.js` 原 SHA `7f13981326b31e78ae7c66406e2961176c2619bb1b2f6b6e4b99ac78e90f1d8c`；候选 SHA `049338abc909b469cda43e9fce69234a792ef7b647d4d886b71ead945b2ca9fa`。
- `dist/cjs/server/webStandardStreamableHttp.js` 原 SHA `51f0bb018442341032d7d5897e204ce48a65cbe5df14db03083fa07e3ca325c1`；候选 SHA `426712eb6c71ad0a0dd9de4d4c97b2210c77551a730c68e98fe1409b520ad60a`。

## 验证

- 原包实际 RED：`/private/tmp/kfw-cu-sdk-cleanup-red.log`，144d75 exit1；无 eventStore 取消后残留1条关联，有 eventStore 会话 close 后残留3条关联。
- 首次 `pnpm patch-commit` 仅登记而未刷新安装/锁文件，原 RED 仍失败；保留该失败。随后 `pnpm install --offline --no-frozen-lockfile --ignore-scripts` 实际应用补丁，既有 LangChain patch hash 保持不变。
- `pnpm --filter @kenfutwork/server exec vitest run src/features/mcp/sdk-transport.test.ts --maxWorkers=1 --no-file-parallelism` 实际 GREEN：`/private/tmp/kfw-cu-sdk-cleanup-both-green.log`，22644 exit0，ESM/CJS×有/无eventStore共4条；每条重复取消3次，确认原POST body结束，无eventStore逐请求释放，有eventStore保留到会话close后释放。
- 明确开启的真实HTTP/PG/Task/Agent/stdio回归：`/private/tmp/kfw-cu-http-lifecycle-green.log`，91734 exit0，跨POST取消、跨session隔离、DELETE重放拒绝、实际撤权与Run停止取消在途调用；响应可被抑制或保留原cancelled结果，不能把actionSent=true误判成操作成功。
- Computer Use/MCP定向129条通过、10条默认跳过；shared115条、全类型13/13任务（9缓存）及仓库/API25条通过（71818 exit0）。不重跑全量pnpm test，默认skip不计OS能力。


真实 HTTP/PG/Task/Agent/stdio 取消、撤权与 Run 停止验证属于协议证明。macOS HTTP 原生取消和最终签名 .app/TCC/安装验收另行完成；锁屏时不运行输入测试。
