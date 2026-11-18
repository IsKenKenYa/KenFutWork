-- Code 宿主通知通道重连间隔；NULL 沿用 env/default，避免把缺省值落成用户覆盖。
alter table public.workspace_settings
  add column code_ui_reconnect_delay_ms integer
  check (code_ui_reconnect_delay_ms between 100 and 60000);
