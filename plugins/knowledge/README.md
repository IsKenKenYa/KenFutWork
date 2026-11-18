# 知识库（SAG2）

本地知识库插件：原文留在用户目录，不落库副本；宿主每轮自动检索并注入证据。

- **能力在宿主内核**：`apps/server/src/features/knowledge/`（SAG CLI Provider、`pre-step` preflight、置顶提示段、`knowledge_search` / `knowledge_read` / `knowledge_status` 工具）。
- **本 bundle 只做安装开关与侧栏面板**：面板数据走宿主 `/api/knowledge/*`，不使用插件私有路由（bundle 沙箱没有子进程与文件能力）。
- **安装即生效**：安装后下一轮 run 自动检索；卸载/停用下一轮立即消失，无需重启。SAG 侧配置与知识库根不会被卸载删除。
- **零配置**：CLI 复用本机已装 `sag`（`@zleap-ai/sag@0.1.8`，仅 Windows x64 / macOS Apple Silicon）；Jev 凭据从宿主 TypeSafe 实例经 stdin 注入，已有配置则复用、绝不覆盖；首次检索按 run 的真实工作目录幂等注册知识库根。
- **隐私**：语义检索会把问题与候选段落发往 Jev 服务；面板可开「本地匹配」（纯本地、不出本机），或在设置里关闭自动注入。

设置与根目录的读取/写入走 `/api/knowledge/settings`、`/api/knowledge/roots`；原文片段走 `/api/knowledge/read`。详见 `docs/插件/SAG2知识库插件规划.md`。
