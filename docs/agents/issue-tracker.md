# 工单追踪

工单和规格发布到 IsKenKenYa/KenFutWork 的 GitHub Issues，使用 gh CLI。

- 读取：`gh issue view <编号> --repo IsKenKenYa/KenFutWork --comments`
- 列表：`gh issue list --repo IsKenKenYa/KenFutWork --state open`
- 发布：`gh issue create --repo IsKenKenYa/KenFutWork --title "<中文标题>" --body-file <正文文件>`
- 标签：`gh issue edit <编号> --repo IsKenKenYa/KenFutWork --add-label "<标签>"`

PRs as a request surface: no.

写操作仍须遵守当前任务授权及 Plan 模式限制。
