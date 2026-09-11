-- Provider Instances: BYOK user provider credentials (《改造计划》§4.8, DEC-7)
-- API keys are stored encrypted (server-side AES-256-GCM via SecretStore),
-- never returned to clients: the API layer only exposes hasCredential.

-- =============================================================================
-- 1. provider_instances table
-- =============================================================================

CREATE TABLE public.provider_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  protocol text NOT NULL,
  base_url text,
  -- AES-256-GCM ciphertext (iv:tag:ciphertext, base64). Never logged, never returned.
  encrypted_api_key text NOT NULL,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  compat jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Protocol is a closed set enforced in app contracts; mirror the guard here.
  CHECK (protocol IN ('openai-compatible', 'anthropic', 'gemini', 'google-image', 'replicate', 'volces', 'metaso')),
  CHECK (jsonb_typeof(models) = 'array')
);

COMMENT ON TABLE public.provider_instances IS 'BYOK user provider instances; api keys stored encrypted (write-only).';
COMMENT ON COLUMN public.provider_instances.encrypted_api_key IS 'AES-256-GCM ciphertext of the user API key. Never returned by any API.';

CREATE INDEX provider_instances_workspace_id_idx ON public.provider_instances (workspace_id);

-- updated_at trigger
CREATE TRIGGER provider_instances_updated_at
  BEFORE UPDATE ON public.provider_instances
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- =============================================================================
-- 2. RLS Policies (workspace isolation — BYOK credential red line)
-- =============================================================================

ALTER TABLE public.provider_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_instances_select ON public.provider_instances
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = provider_instances.workspace_id
        AND wm.user_id = auth.uid()
    )
  );

CREATE POLICY provider_instances_insert ON public.provider_instances
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = provider_instances.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY provider_instances_update ON public.provider_instances
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = provider_instances.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY provider_instances_delete ON public.provider_instances
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = provider_instances.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );
