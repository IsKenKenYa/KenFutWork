# 冒烟场景清单（社区版只读 15 端点）

> **角色**：参考。断言字段以 `docs/api/openapi.json` 中各端点响应 schema 的顶层字段为准（本文表格是派生快照，改契约后随 `pnpm api:spec` 同步核对）。

## Apifox 侧现状

- 场景：**「社区版只读冒烟（15 端点）」**（scenarioId `8814394`，位于 AI 分支 `ai/20260930-from-main-api-docs-initial-import`），15 个步骤全部以 `bindType=API + syncMode=MANUAL` 绑定接口定义，跟随 `pnpm api:spec` → `apifox import` 的接口更新。
- 断言：Apifox 用例级（步骤内）处理器当前不支持 assertion 位（CLI schema 仅 extractor/database/script 类）；状态码与结构断言请在 **UI 每步「后置操作」** 补两条：① 响应状态码 == 200；② `$.<断言字段>` 存在（字段见下表）。绑定接口定义的步骤在 UI 运行时另受接口文档自动校验。
- 运行：CLI `test-scenario run` 当前对免费团队返回后端 500（疑 FREE 套餐/Runner 限制），请在 Apifox UI 内运行（环境选「开发环境」= `http://localhost:3001`，对本机 local-trust dev server 免令牌）。

## 断言清单（2026-09-30 对本地 dev server 实测 15/15 通过）

| # | 端点 | 状态码 | 响应核心字段断言 |
| --- | --- | --- | --- |
| 1 | `GET /api/health` | 200 | `$.ok` 存在 |
| 2 | `GET /api/projects?kind=design` | 200 | `$.projects` 存在 |
| 3 | `GET /api/model-catalog` | 200 | `$.models` 存在 |
| 4 | `GET /api/usage/summary` | 200 | `$.byModel` 存在 |
| 5 | `GET /api/usage/stats?days=7` | 200 | `$.byModel` 存在 |
| 6 | `GET /api/viewer` | 200 | `$.credits` 存在 |
| 7 | `GET /api/credits` | 200 | `$.balance` 存在 |
| 8 | `GET /api/skills` | 200 | `$.skills` 存在 |
| 9 | `GET /api/workspaces/skills` | 200 | `$.skills` 存在 |
| 10 | `GET /api/workspace/settings` | 200 | `$.settings` 存在 |
| 11 | `GET /api/jobs` | 200 | `$.jobs` 存在 |
| 12 | `GET /api/execution-modes` | 200 | 响应体非空（响应无具名 schema） |
| 13 | `GET /api/provider-instances/presets` | 200 | `$.presets` 存在 |
| 14 | `GET /api/mcp/servers` | 200 | 响应体非空（响应无具名 schema） |
| 15 | `GET /api/permissions/tier` | 200 | 响应体非空（响应无具名 schema） |

## 维护方式

- 新增/调整冒烟端点：改本表 + 在 Apifox 场景 `8814394` 用「导入步骤（来源：接口）」补步骤；断言字段从 `docs/api/openapi.json` 对应响应 schema 取顶层字段。
- 全量契约回归不要靠冒烟（它只保活）；结构级回归由 `tests/api-spec-consistency.test.mjs` 门禁与各包 vitest 承担。
