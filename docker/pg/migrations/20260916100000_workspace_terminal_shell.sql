-- 右栏「终端」用的 shell（用户口径：「终端应该是直连 cmd 或者 powershell、git-bash 等等，
-- 可以在设置里配置默认的」）。
--
-- 取值是**封闭集合**（与 packages/shared 的 terminalShellSchema 同一口径）：写错在这里就报错，
-- 不留给运行期猜。`auto` = 按平台取默认（Windows → cmd，POSIX → sh）；本机有没有某个 shell
-- 由服务端探测，设置里选了这台机器没有的会落回平台默认。
ALTER TABLE public.workspace_settings
  ADD COLUMN terminal_shell text NOT NULL DEFAULT 'auto';

ALTER TABLE public.workspace_settings
  ADD CONSTRAINT workspace_settings_terminal_shell_check
  CHECK (terminal_shell IN ('auto', 'cmd', 'powershell', 'pwsh', 'git-bash', 'bash', 'sh'));

COMMENT ON COLUMN public.workspace_settings.terminal_shell IS
  'Shell used by the docked terminal tab (auto = platform default).';
