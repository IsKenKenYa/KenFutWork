-- 原 Code 供应商草稿使用真实“未配置凭证”，不存假 Key 或占位模型。
ALTER TABLE public.provider_instances ALTER COLUMN encrypted_api_key DROP NOT NULL;
COMMENT ON COLUMN public.provider_instances.encrypted_api_key IS
  'AES-256-GCM ciphertext; NULL means no credential configured. Write-only; never returned by APIs.';

-- 整个工作区供应商聚合的真实单调修订，配置写入提交时同步推进。
CREATE TABLE public.provider_registry_revisions (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE FUNCTION public.advance_provider_registry_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_workspace uuid;
BEGIN
  -- 探测缓存、updated_at 与同值保存都不改变配置 View。
  IF TG_OP = 'UPDATE' AND
    (OLD.name, OLD.protocol, OLD.base_url, OLD.encrypted_api_key, OLD.models, OLD.compat, OLD.headers, OLD.enabled)
      IS NOT DISTINCT FROM
    (NEW.name, NEW.protocol, NEW.base_url, NEW.encrypted_api_key, NEW.models, NEW.compat, NEW.headers, NEW.enabled) THEN
    RETURN NULL;
  END IF;
  target_workspace := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  IF target_workspace IS NOT NULL AND EXISTS (SELECT 1 FROM public.workspaces WHERE id = target_workspace) THEN
    INSERT INTO public.provider_registry_revisions (workspace_id, revision)
    VALUES (target_workspace, 1)
    ON CONFLICT (workspace_id) DO UPDATE
      SET revision = public.provider_registry_revisions.revision + 1;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER provider_registry_revision
AFTER INSERT OR UPDATE OR DELETE ON public.provider_instances
FOR EACH ROW EXECUTE FUNCTION public.advance_provider_registry_revision();
