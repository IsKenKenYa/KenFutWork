-- 原供应商配置的非敏感叶子与模板标识，仍归 provider_instances 一处持有。
ALTER TABLE public.provider_instances ADD COLUMN code_ui_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.provider_instances ADD CONSTRAINT provider_code_config_write_only CHECK (
  jsonb_typeof(code_ui_config) = 'object'
  AND code_ui_config #> '{config,access,apiKey}' IS NULL
  AND code_ui_config #> '{config,api,headers}' IS NULL
  AND code_ui_config #> '{config,api,baseUrl}' IS NULL
  AND code_ui_config #> '{config,personalModelIds}' IS NULL
  AND code_ui_config #> '{config,builtinModelIds}' IS NULL
  AND code_ui_config #> '{config,modelOrder}' IS NULL
);
COMMENT ON COLUMN public.provider_instances.code_ui_config IS
  'ZCode provider non-secret configuration leaves and template identity; credentials, headers, endpoint and model membership remain in their canonical columns.';

CREATE OR REPLACE FUNCTION public.advance_provider_registry_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_workspace uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND
    (OLD.name, OLD.protocol, OLD.base_url, OLD.encrypted_api_key, OLD.models, OLD.compat, OLD.headers, OLD.enabled, OLD.code_ui_config)
      IS NOT DISTINCT FROM
    (NEW.name, NEW.protocol, NEW.base_url, NEW.encrypted_api_key, NEW.models, NEW.compat, NEW.headers, NEW.enabled, NEW.code_ui_config) THEN
    RETURN NULL;
  END IF;
  target_workspace := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  IF target_workspace IS NOT NULL AND EXISTS (SELECT 1 FROM public.workspaces WHERE id = target_workspace) THEN
    INSERT INTO public.provider_registry_revisions (workspace_id, revision)
    VALUES (target_workspace, 1)
    ON CONFLICT (workspace_id) DO UPDATE SET revision = public.provider_registry_revisions.revision + 1;
  END IF;
  RETURN NULL;
END;
$$;
