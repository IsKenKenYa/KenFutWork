-- 项目工作目录（Code 项目绑定本机真实目录）
--
-- 背景：桌面形态用系统文件夹选择器拿到绝对路径，Web 形态的
-- `window.showDirectoryPicker` 只给得到**目录名**（FileSystemDirectoryHandle 传不到
-- 服务端），于是「工作目录」在 Web 上只能是标识符，agent 实际写在
-- `<sandboxRoot>/<canvasId>` 里。用户明确要求 Web 形态也能绑定本机目录 —— 做法是
-- 让用户**手动填绝对路径**，服务端校验（绝对路径 + 存在 + 是目录）后落库。
--
-- 该值经 `resolveSandboxDir` 成为项目主画布的工作目录，即 agent 文件工具/execute 的
-- cwd、终端会话的落点、git 操作的目录（三处同一判定，不允许各算各的）。
alter table public.projects
  add column if not exists work_dir text;

comment on column public.projects.work_dir is
  'Code 项目绑定的本机工作目录绝对路径；为空时按 <sandboxRoot>/<canvasId> 落沙箱目录';
