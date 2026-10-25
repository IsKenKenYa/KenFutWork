-- 会话模式加第四类 `work`（办公 / 生产力创作会话，与 work 项目同一族封闭枚举）。
--
-- 依据：《work 模式集成规划》WD-1——Work 与 code/design/flow 共用原会话 UI 与
-- Task 宿主；用户在 Work 模式下经共享会话交互时，chat_sessions.mode 会写 'work'。
-- work 会话与 code 会话同一形态：不绑画布（canvas_id 为 NULL）。
--
-- 前向迁移：不改历史迁移（`20261002192638_code_task_execution_scope.sql` 的约束
-- 原文保持不动），此处按同一约束名重写两条约束与列注释。

alter table public.chat_sessions
  drop constraint if exists chat_sessions_mode_check;

alter table public.chat_sessions
  add constraint chat_sessions_mode_check
    check (mode in ('design', 'code', 'flow', 'work'));

alter table public.chat_sessions
  drop constraint if exists chat_sessions_mode_canvas_check;

alter table public.chat_sessions
  add constraint chat_sessions_mode_canvas_check
    check ((mode in ('code', 'work') and canvas_id is null)
      or (mode in ('design', 'flow') and canvas_id is not null));

comment on column public.chat_sessions.mode is
  '持久产品模式（design/code/flow/work，与 projects.kind 同族）；Run 不得通过 preset 改变 Task 模式；work 与 code 同形态（无画布）';
