-- Usage Records: BYOK usage metering (DEC-6 — BYOK v1 必备；credits 关闭后是唯一计量)
-- Two collection points land here: agent chain (LangChain streamUsage, attributed
-- at the turn-stopping event seam) and direct generation chain (job completion).
-- Token counts are zero for image/video providers that don't report them — the
-- row still records provider/model/job so direct generation leaves no blind spot.

CREATE TABLE public.usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider_instance_id uuid REFERENCES public.provider_instances(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  capability text NOT NULL CHECK (capability IN ('chat', 'image', 'video')),
  run_id text,
  job_id uuid,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens bigint,
  cost_usd numeric(12, 6),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.usage_records IS 'BYOK usage metering; append-only telemetry written with the service role.';

CREATE INDEX usage_records_workspace_occurred_idx ON public.usage_records (workspace_id, occurred_at DESC);
CREATE INDEX usage_records_run_id_idx ON public.usage_records (run_id);

-- RLS: members read their workspace usage; inserts happen only via the service role.
ALTER TABLE public.usage_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_records_select ON public.usage_records
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = usage_records.workspace_id
        AND wm.user_id = auth.uid()
    )
  );
