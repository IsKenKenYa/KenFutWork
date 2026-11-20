ALTER TABLE public.context_model_requests
  ADD COLUMN purpose text NOT NULL DEFAULT 'agent'
  CHECK (purpose IN ('agent', 'automatic-compaction', 'manual-compaction', 'goal-evaluation', 'approval-review'));
COMMENT ON COLUMN public.context_model_requests.purpose IS '真实模型调用方声明的用途；独立于Task、Run和子Agent身份';
