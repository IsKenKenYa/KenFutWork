# 贡献指南

KenFutWork 是 BYOK AI 工作台，社区版以 GPL-3.0-only 发布。感谢你愿意贡献。

## 1. 先读这几份

- [`CONTRIBUTING.md`](CONTRIBUTING.md)：本文。
- [`CLA.md`](CLA.md)：提交 PR 前必须签署。
- [`GOVERNANCE.md`](GOVERNANCE.md)：角色、决策、双仓边界与收益原则。
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)：行为准则。
- [`SECURITY.md`](SECURITY.md)：安全漏洞私报。
- [`AGENTS.md`](AGENTS.md)：开发命令、测试与提交纪律的唯一权威。

## 2. 社区版与商业版

- **社区版**：公开仓，GPL-3.0-only，功能完整。
- **商业版**：独立私有仓，专有许可；只使用项目方自有、已获再许可或宽松许可的代码与素材。
- 你的贡献会进入社区版；签署 CLA 后也可能进入商业版。
- 普通贡献者不因提交 PR 自动获得商业收益分成；主要人员另行签署内部协议。
- 贡献不授予项目名称、标识或商标权。

## 3. 贡献前必须签 CLA

- 本项目**不使用 DCO**。DCO 只能证明你有权按项目许可证贡献，不能授予再许可权，无法支持商业版。
- 首次 PR 会被托管 CLA Assistant App 要求签署 [`CLA.md`](CLA.md)。按评论提示回复：

  ```text
  I have read the CLA Document and I hereby sign the CLA
  ```

- 公司贡献者：签署 CLA 附件 B（CCLA），通过 GitHub 联系 `@IsKenKenYa` 安排提交与核验；核验后加入 allowlist。
- 托管 CLA Assistant 使用 `CLA.md` 的 Gist 副本作为签署文本；仓库 `CLA.md` 是编辑源，更新后需同步 Gist。
- 如不希望使用托管服务，可按 `CLA.md` 附件 A 线下签署，并联系 `@IsKenKenYa` 登记。个人信息处理见 [PRIVACY.md](PRIVACY.md) §13。
- 未签 CLA 的 PR 不合并。
- Issue 不需要 CLA；提交即表示允许项目在讨论与改进中使用该内容。

## 4. 可以贡献什么

- **Bug 报告**：使用 `.github/ISSUE_TEMPLATE/bug_report.yml`；不要贴密钥、凭据或个人数据。
- **功能请求**：使用 `.github/ISSUE_TEMPLATE/feature_request.yml`；说明使用场景与范围（Code / Design / Flow / Work）。
- **代码、测试、文档、翻译、设计、技能与插件**。
- **安全漏洞**：不要开公开 issue，走 [`SECURITY.md`](SECURITY.md)。

## 5. 开发环境与命令

- Node 24.22.1、pnpm 10.26.2；根 `.env.local` 模板见 `.env.example`。
- `pnpm install`
- `pnpm dev`（web 3000 / server 3001 / worker）
- `pnpm --filter @kenfutwork/server dev:server`
- `pnpm --filter @kenfutwork/server dev:worker`
- `pnpm test` / `pnpm typecheck` / `pnpm lint`
- `pnpm test:docs` / `pnpm test:workspace`
- API 改动：`pnpm api:spec`，并同步 `docs/api/openapi.json` 与 Apifox。

完整命令、门禁与提交纪律以 [`AGENTS.md`](AGENTS.md) 为准；本文不复制。

## 6. 分支、提交与 PR

- 外部贡献者分支：`contrib/<GitHub用户名>/<中文简述>`。
- 维护者分支：按 [`AGENTS.md`](AGENTS.md) 的 `<agent>/<中文描述>` 约定。
- 小步提交；commit 使用 `feat(scope): ...` / `fix(scope): ...`，中文为主。
- 不直接 push `main`；所有改动走 PR。
- PR 描述包含：问题/方案摘要、验证命令、关联 issue 或 spec、UI 截图或录屏。
- PR 模板中的检查项必须逐条确认；CLA 未签会被状态检查拦住。

## 7. 代码与测试要求

- TypeScript strict；Biome（两空格、双引号、分号）；ESM；`camelCase` 函数/变量、`PascalCase` 组件/类型。
- 一个函数只做一件事；超过 80-100 行或职责混杂要拆。
- 新逻辑先 grep 同类实现，能复用就复用；新文件必须同 PR 接线。
- Bug 修复必须带回归测试；测试覆盖边界、异常、并发、幂等重放、空/超长输入。
- integration 测试命名 `*.integration.test.ts`，默认 skipped，CI 不强制运行。
- 不要同时跑多个测试实例；需要串行时用 `pnpm exec turbo run test --concurrency=1`。
- 不写无意义断言；测试行为而非实现细节。
- 新增运行时数值必须进 `packages/shared/src/governance.ts`，禁止硬编码。

## 8. API 契约

- 契约唯一属主：`packages/shared/src/`。
- 路由登记：`apps/server/src/openapi/registry.ts`（中文 summary/description 非空）。
- 生成：`pnpm api:spec`。
- 漂移门禁：`tests/api-spec-consistency.test.mjs`。
- WS 与流事件不入 OpenAPI，导读见 `docs/api/ws-protocol.md` 与 `docs/api/job-events.md`。

## 9. 第三方资产

- 新依赖、图标、字体、模型权重、vendored 代码必须在同一 PR 登记到 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)：来源、许可、版权人、义务履行位置、商业版可用性。
- 无 LICENSE 的资产如实标「待核」，不能默认按 GPL 或 MIT 分发。
- 未满足许可证义务的 GPL/无许可资产不得进入商业版；具体分级见 `THIRD-PARTY-NOTICES.md` §H。
- 品牌图标仅作指示性使用；不要暗示背书或隶属关系。

## 10. 商业版与贡献者

- 你的贡献可能出现在商业版；商业版许可见 [`COMMERCIAL-LICENSING.md`](COMMERCIAL-LICENSING.md)。
- 普通贡献者不自动参与收益分配；项目可对特定任务发放一次性奖励，需书面确认。
- 主要人员（共同所有者 + 签署内部协议的核心维护者）另签保密/收益协议；商业版私有仓仅对其开放。
- 不要在公开 PR 中提交客户合同、报价、签名、个人邮箱或私有仓代码。

## 11. 审查与沟通

- 维护者尽力响应，无 SLA。
- 使用 `needs-triage` 等标签；维护者按 `docs/agents/triage-labels.md` 处理。
- 大改动先开 issue 对齐范围；不要先写几千行再问。
- 行为准则见 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)；安全问题见 [`SECURITY.md`](SECURITY.md)。

## 12. 许可与版权

- 社区版 GPL-3.0-only；CLA 授予项目方再许可权；版权归属见 [`COPYRIGHT.md`](COPYRIGHT.md)。
- 贡献不改变第三方组件许可；不要移除版权、许可或 NOTICE 声明。

## 13. 联系

- 代码与文档：GitHub Issues。
- 安全：GitHub Security Advisories。
- 商业许可：[`COMMERCIAL-LICENSING.md`](COMMERCIAL-LICENSING.md)，通过 GitHub 联系 `@IsKenKenYa`。
- 行为准则：[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
