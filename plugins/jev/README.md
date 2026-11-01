# Jev 判决

把 [jev-mcp](https://github.com/jkudish/jev-mcp) 这一套判断工具接进会话：核验主张与证据是否相符、进上下文前先筛不可信内容、语义查找与重排、分类与抽取。

装好后在 **MCP 服务器 → 精选目录** 里点「Jev 判决」添加，填入 TypeSafe API Key 即可。工具以 `mcp__jev__jev_verify` 这类名字出现在会话里。

## 前提

- 本机有 Node（用 `npx` 拉起 server）。
- 一把 TypeSafe API Key：Jev 是云侧模型，没有凭据 server 起不来。

## 边界

插件不训练模型、不内置判决逻辑，也不自己起 MCP 子进程——连接、按任务隔离与审批都归宿主的 MCP 服务管。这样「工具在不在」只有一个真相，不取决于谁先连上。
