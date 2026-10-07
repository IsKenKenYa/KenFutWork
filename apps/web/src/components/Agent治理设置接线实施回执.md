# Agent 治理设置接线实施回执

角色：本轮第一方设置接线与窄范围验收记录；不代表完整 Code/Design/Harness 改造已完成。

## 行为与落点

- Code 原 iframe 外既有「本地实例」弹窗和 Design 设置的「Agent 治理」共用同一 View 与实例读写 controller。原 ZCode 登记源码未修改。
- 七项数字及无限重试从实际成功响应选择，护栏直接消费 shared governance。未读到配置时显示加载或错误，缺字段不补默认真值；空值、小数和越界不能保存。
- 两项压缩值是配置保留目标，实际保留受工具配对与溢出恢复影响。目标消费的后端验收见 `apps/server/src/features/code-ui/压缩保留目标治理实施回执.md`。
- 同 API endpoint 的设置写入按 FIFO 发送，GET 等待已发送写入结算。模块只保留 Promise 屏障，不缓存设置或凭据；关闭/更换 scope 后尚未发送的旧操作不再派发，旧回包不覆盖新打开页面。
- 无关完整设置回包不重置治理草稿。Design 命令/钩子集合实际字段未变时保留引用，防止这两页按引用重建表单清空草稿。

## 真实回归

组件运行实际 Code/Design 入口，使用原 LocalInstanceProvider、原 API、buildApp、LocalAccess 浏览器接入与隔离 Postgres。relay 仅转发真实响应，request gate 暂停发送，response gate 延迟回包，drop 断开传输；不合成业务 DTO，不 mock 自家模块。

- 原两个索引开关真实提交乱序导致 UI 停在旧值：`64805` RED → `69668` GREEN。
- 无关索引回包抹掉治理草稿：`76236` RED → 后续真实 GREEN。
- 无关索引回包清空命令草稿：`45544` RED → `29261` GREEN；同族钩子覆盖随后补齐。
- 保存、数字护栏、并发、关闭重开、GET/PATCH 连接失败与重试、旧请求迟到，共 14 个真实场景。默认 integration skip 不计能力验收。
- jsdom `import.meta.url`、Testing Library 类型选项、跨 NodeNext `.js` 后缀和新增参数化 gate 名重复均属夹具/类型问题，未作为产品 RED。
- 最终完整 `pnpm test`：`86134` 实际退出 0，16/16 任务（15 缓存），Web 460 通过/14 默认 skip。server 2010 通过/214 默认 skip 沿本批先前实跑完整证据；skip 不计能力。集合下标类型未收窄 `62545` 失败后补存在 guard，`42153` 最终全 types 13/13 实际退出 0。

可复制命令（真实测试需要本机子进程/PG/回环权限；全部串行）：

```sh
RUN_GOVERNANCE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/web exec vitest run test/governance-ui-save.integration.test.tsx
pnpm --filter @kenfutwork/web exec vitest run test/agent-governance-inputs.test.ts
pnpm test
pnpm typecheck
```

## 浏览器呈现后验收

2026-10-06，独立 `localhost:3300` Next、真实 API/PG，同一实例 `530467af-6077-4a13-9cfe-227daf269c9f`：

1. 原 Code Root/iframe 正常呈现，「本地实例」保存 2/1，出现真实成功反馈；公开 GET 与 PG 均为 2/1。
2. Design 真实设置读回 2/1，保存 3/2，公开 GET 与 PG 均为 3/2。
3. 关闭 Design 设置后，主区仍为 `/canvas?id=b26c6a25-c1e5-489b-9a1e-0636dac90fea`，画布、工具栏与画布助手呈现。
4. 通过模式入口返回 Code，再打开本地实例，读回 3/2。最后仅停止本次专用 Next/API/PG，现有 3000/3001 和固定 TCC app 未操作。

截图/读回事实保存于 `/private/tmp/kfw-governance-browser-acceptance-20261006/`：`Code治理保存.jpg`、`Design治理保存.jpg`、`Design关闭后画布.jpg`、`Code读回Design设置.jpg`、`Code保存事实.json`、`Design保存事实.json`。

临时工程首轮源码目录符号链接未被路由扫描识别；副本与原路径混用又产生重复 Context。修正临时启动器为源码副本且 alias 统一指向副本后完成上述验收，产品源码没有为夹具绕行。首屏编译约一分钟时 CUA 导航超时，后续实际画面与 DOM 正常；模式入口 `check` 在切换后因原控件卸载报超时，后续 DOM 确认已经回到 Code。

## 验收边界与后续

浏览器夹具无 WS upgrade，Design 显示断线重连，因此只证明本轮设置呈现/持久化与主区画布不变量，不计完整画布同步、生成、全场景视觉或原 ZCode 全操作验收。

第一批提交 `cf60700e` 时命令/钩子仍直连原 update API，按下一独立切片处理。巨大历史/overflow、主子规划与冷恢复、媒体/文件/三平台、Task Work/MCP/插件发现等仍在完整 Goal 内。

## 2026-10-06 命令与钩子保存消费者收口

两页保存现在只调用由 SettingsModal 注入的 `onSave`；SettingsModal 经同一实例 controller 部分 PATCH，再将实际响应数组返回表单。移除表单直连 API、凭据参数与裸 `onSaved` setter。原整表替换、空表清空、trim 和校验规则保留；scope 变化的 null 结果拒绝成功提示，合法空数组仍可成功。

- `15032` 命令真实 RED：公开 GET 已持久化新命令，早索引完整回包却抹掉页面；`19370` GREEN。首 `90706` 的持久化/当前页已通过，但重开测试未等实际 GET 导致失败，补等待后通过，未伪称第二个生产错误。
- `12758` 钩子同族真实 RED → `48837` 两消费者 GREEN。首两次 `-t` 未匹配 Vitest 带引号的参数化标题，全 skip 不计 RED/GREEN；读取 `vitest list` 的实际名称后才执行。
- `63255` 最终 16 条真实 HTTP/PG/UI 场景全部通过：两页保存后读回与重开、原 14 条治理/并发/生命周期/草稿场景保持。
- `7148` 最终完整 `pnpm test` 实际退出 0，16/16（14 缓存），server 2010/Web 460 通过；默认 server 214/Web 16 skip 不计能力。`72488` 全 types 13/13 实际退出 0（11 缓存，server/web 实跑）；8 本域源码 Biome 实际退出 0。
- 测试 `collections` 从原公开 HTTP schema 的 commands/hooks 投影，不合成响应、不调用新业务实现计算期望，也不执行配置的命令或钩子。原表单测试转为验证公开保存 callback，实际存储/时序由上述真实回归承接。

本片未改 HTTP 契约，无 OpenAPI/Apifox 更新；未改原 ZCode 字节或 Design 画布入口。共享屏障的范围限于已接线的治理、模型、索引、命令与钩子消费者，不宣称其余独立设置面都迁移完毕。
