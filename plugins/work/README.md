# Work 办公创作

安装后工作台出现第四种工作方式（Work）：主区承载**编辑器扩展包**——原生 Office（表格 / 文档 / 演示）、图片、视频等生产力编辑器，按需下载、iframe 内嵌（WASM 档）或原生窗口（桌面档）。

- 入口纪律：未安装本插件时工作台不出现 Work 入口；已安装后编辑器按扩展包落位态出现，不摆空壳。
- 编辑器二进制不随安装包分发；来源与许可证（ArtCraft / storytold 系列，MIT OR Apache-2.0）见工作台「Work 引擎」信息页。
- 服务端基础设施在 `apps/server/src/features/work/`（注册表与数据目录事实），契约在 `packages/shared/src/work-host.ts`。
