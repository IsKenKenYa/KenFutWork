alter table public.instance_settings
  add column theme text;

alter table public.instance_settings
  add constraint instance_settings_theme_check
  check (theme in ('system', 'zai-light', 'zai-dark'));
