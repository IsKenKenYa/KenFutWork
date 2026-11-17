-- Code run 终态自动 git 提交开关（工作台融合兼容计划 G3，Q8 拍板）。
--
-- 每轮 Code run 进入终态（completed/failed/canceled）时，若 Task 根目录是 git 仓库，
-- 服务端把全部未提交变更 `git add -A` + commit（提交信息按 `git status --porcelain`
-- 变更统计启发式生成，不调 LLM）。非仓库静默跳过（init 是独立入口）、干净工作区静默
-- 跳过、失败只 warn 不阻塞 run 终态。
--
-- 缺省 true（默认开）：每轮留一份可回溯的提交对用户是纯增益；不想要的人可在设置里关。
-- 默认值的应用层唯一属主是 packages/shared 的 CODE_AUTO_COMMIT_ENABLED_DEFAULT，
-- 本列 default 只负责存量行回填，两侧语义保持一致。
alter table public.instance_settings
  add column if not exists code_auto_commit_enabled boolean not null default true;

comment on column public.instance_settings.code_auto_commit_enabled is
  'Code run 终态自动 git 提交：每轮 run 结束把 Task 工作目录全部变更 add -A + commit；非仓库/干净工作区静默跳过';
