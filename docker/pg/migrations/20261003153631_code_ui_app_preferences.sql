-- 原 Code Root 的应用/显示偏好与 tab 快照；最近目录仍由既有独立列持有。
alter table public.workspace_settings
  add column code_ui_app_preferences jsonb;

alter table public.workspace_settings
  add constraint workspace_settings_code_ui_app_preferences_check
  check (
    code_ui_app_preferences is null
    or (
      jsonb_typeof(code_ui_app_preferences) = 'object'
      and not (code_ui_app_preferences ?| array[
        'recentProjects', 'apiKey', 'headers', 'credentials'
      ])
    )
  );
