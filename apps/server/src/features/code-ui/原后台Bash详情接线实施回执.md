# 原后台 Bash 详情接线

日期：2026-10-06。共享分支：`codex/完整移植ZCode-Code界面`。

## 问题与实现

原 `BackgroundBashOutputSidePane` 已装配，但 `backgroundBashOutputV4` 尚未接通。直接拿宿主捕获路径打开文件，也会与 Task 授权目录冲突。

现沿 CodeUi provider 接通原 RPC，读取当前 Task 的真实命令捕获或其独立只读历史副本。预览返回当前状态与受治理预算限制的尾窗；`code-output:<taskId>/<id>` 是只读资源引用，不能充当执行身份或任意路径。原全文按钮沿现有 Channel 的 viewerScope 注入，支持文本、字节分页、文件大小及 resolvePath。没有新增 HTTP 端点、第二套 UI 或 app/worker 装配。

日志缺失和损坏使用原 `read_failed`，只返回错误码；未知工作为 `unavailable`，非命令工作为 `unsupported`。工作域错误在读取前拒绝。运行日志允许追加，终态日志核对持久字节事实，读取期间核对文件句柄和路径 inode；UTF-8 尾窗跳过开头 continuation 字节，运行中的不完整末码点留给下一次查询。

## 实际证据

- 首条真实 HTTP/SSE/PG/Harness/沙箱场景在原 RPC 的 501 上取得 RED，接通后 GREEN。首次 schema 导入错误已修正，收据 `/private/tmp/kfw-background-view-{red,green,green2}-20261006.log`。
- `91609` 是夹具误从后台派发结果取捕获路径；`55258` 是夹具误等已自动续跑的 Task 空闲，另有启动输出尚未可读的竞态。修正为公开 TaskOutput、自动通知 Run 和实际日志可读条件，不把这些夹具失败记作产品 RED。
- `5675` 取得实际文件丢失的产品 RED：原 RPC 返回 500 并暴露私有路径。修复后 `89132` 两场景通过。`67091` 取得实际终态文件损坏仍返回 output 的 RED；补持久字节核对后 `55169` 五条真实服务场景通过。
- 最终 `17637` 实际收集四文件、14 条全部通过，无 skip：运行/终态、丢失/损坏后恢复、跨 Task/目录拒绝、中文与 emoji 尾窗、全文/大小/字节页、父删除后的只读副本、原生资源与子停止。命令中多写的不存在 `history-fork-native.integration.test.ts` 未计入能力；以下命令仅列实际收集文件。
- `81709` 原 GUI 两条通过，无 skip。原后台组件和真实 CodeHttpChannelClient 完成查询、隐藏后重开、终态显示与全文按钮读取；同一抽取的 Node→独立 DOM 夹具回归原子代理停止。没有 mock 内部服务或改原组件字节；仅外部模型接口受控，不冒称真实供应商模型验收。
- 来源核对 3027 项、零漂移；新增五个源码完整 Biome 通过。已有五个修改文件关闭历史 formatter/assist 的 lint 通过，84 条既有 warning 保留。

最终门禁：`8726` 全类型13/13（server实际、12缓存；先前38859为server/web实际、11缓存），`50596` 完整pnpm test16/16（server/web实际、14缓存；server2024通过/248默认skip、web460通过/18默认skip）。默认skip不计能力，新增场景已单独实际执行。五个新源码最终完整Biome无warning，diff与3027来源零漂移通过。

## 验证命令

```sh
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run --maxWorkers=1 --no-file-parallelism src/features/code-ui/background-output-view.integration.test.ts src/features/code-ui/history-fork-output.integration.test.ts src/features/code-ui/foreground-child-control.integration.test.ts src/agent/native-context-resources.test.ts
RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/web exec vitest run --maxWorkers=1 --no-file-parallelism test/code-background-output-public.integration.test.tsx test/code-foreground-child-control-public.integration.test.tsx
pnpm typecheck
pnpm test
node scripts/vendor-zcode.mjs
```

## 范围与剩余项

本批证明原后台面板及其全文按钮的公共链。原 PreviewPane 的完整渲染、全场景视觉与全部 Code 操作、运行中历史分叉截点恢复、所有生成产物、巨大历史、Design/Flow 与三平台验收继续，整体 Goal 保持 active。原文本查看器和日志读取均遵守用户治理上限，超预算不伪装完整文件；历史副本不获得 stdin/stop 权限。
