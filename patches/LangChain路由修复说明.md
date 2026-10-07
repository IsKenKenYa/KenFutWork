# LangChain 模型续跑路由修复

固定包：官方 npm langchain 1.5.11，MIT。通过 pnpm patchedDependencies 记录，不直接修改安装硬链接。上游 Git SHA 未随包提供，未据此虚构。

## 原因与范围

原 afterModel 的显式 model 跳转直达模型节点，绕过 beforeModel；final router 在纯文本回复时还先结束后判断跳转。修复让显式跳转先于纯文本终止，并回到既有 loopEntryNode，清理 jumpTo。默认工具/structured-response路径与tools/end、afterAgent行为保留，不嵌入产品插件名、不增加并行Command.goto或另一个Agent loop。

补丁：langchain@1.5.11.patch，ESM/CJS两个发行入口。原MIT许可：LICENSE-langchain.txt。发行source map未改，映射仍来自上游TypeScript；发行代码的行号变化不反映在原map中。升级时须重新审查上游是否已修复、重新验证公共跳转和消息持久语义，再退役或重建补丁。

## 来源SHA-256

- `dist/agents/ReactAgent.js` 原 SHA `8091e09101295ab0cac5dfef70c25542b676356b1d89b86f10be68e7aa5246c7`，候选 SHA `311a020b7075d32596342810fafc5dd8364b3980030e67ae7bf6cd46355ab6ac`。
- `dist/agents/ReactAgent.cjs` 原 SHA `55069419e51283fd5da6d03c241afe3cba221243adee7f37c681d41265af4bb9`，候选 SHA `0ed859de8139eda73c1e260454ad80ead789484a9143e2ca67a7c19986464e6a`。

## 验证

- 原产品正文guide真实RED：/private/tmp/kfw-guide-text-product-red.log，94355退出1，指导改成另一个Run。
- 正文/工具/未消费停止3条真实HTTP/PG/native回归：/private/tmp/kfw-guide-text-tools-green.log，12181退出0；完整两次真实AI回复、guide及native消息保留在同Run，原followup routing匹配guide。
- 公共SDK44条：/private/tmp/kfw-sdk-model-continuation-green.log，4879退出0；ESM/CJS与工具v1/v2、0/1/多个beforeModel、final/sequence、tools/end、afterAgent及toolStrategy默认结果。有限外部模型脚本与真实SDK tool/graph，未替换私有路由。
- 运行取消/检查点/后台续轮与输入投影共101条：/private/tmp/kfw-guide-text-sdk-regressions.log，32802退出0。
- 最后完整server类型检查：/private/tmp/kfw-guide-text-final-types.log，5040退出1，新公共SDK测试的可选jumpTo字段未收窄；已修正。复核完整server类型检查 /private/tmp/kfw-sdk-commit-server-types.log，87210退出0；早先失败日志保留。

不包含整个Code/Design目标、guide切配置/独立pre历史/权威工时、真实原GUI全场景或最终桌面签名产物验收。
