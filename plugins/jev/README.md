# Jev 判决

把 [jev-mcp](https://github.com/jkudish/jev-mcp) 这一套判断工具接进会话：核验主张与证据是否相符、进上下文前先筛不可信内容、语义查找与重排、分类与抽取、补丁审查与完成门禁。

两件事随插件生效：

- **技能 `jev-judgment`**：插件启用后自动进入 agent 的可用技能清单，教会它何时该调判决工具、而不是凭自己的阅读直接作答。
- **MCP 服务**：在 **MCP 服务器 → 精选目录** 里点「Jev 判决」添加，填入 TypeSafe API Key 即可。工具以 `mcp__jev__jev_verify` 这类名字出现在会话里。

## 前提

- 本机有 Node（用 `npx` 拉起 server，版本钉在 `@jkudish/jev-mcp@0.10.0`，与技能文本对应的工具集一致）。
- 一把 TypeSafe API Key：Jev 是云侧模型，没有凭据 server 起不来。

## 边界

- 插件不训练模型、不内置判决逻辑，也不自己起 MCP 子进程——连接、按任务隔离与审批都归宿主的 MCP 服务管。这样「工具在不在」只有一个真相，不取决于谁先连上。
- 每次判决调用都会把输入文本发给 TypeSafe Jev API（输入离开本机），按 key 所属账户的输入 token 计费；不要发送密钥或私有源码，除非你的策略允许。

## 来源

技能移植自 ZCode 官方插件 `jev-decisions` 0.1.0（作者 kittimzhe，MIT），其本身改编自 `@jkudish/jev-mcp` 包内官方技能（MIT，Copyright (c) 2026 Joey Kudish）。许可文本在 `skills/jev-judgment/LICENSE.txt`，归属链见根 `THIRD-PARTY-NOTICES.md` A6。