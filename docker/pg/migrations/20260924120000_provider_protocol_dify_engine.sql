-- Provider protocol closed set: add 'dify-engine' (《flow 集成方案》P3 凭证缝).
-- Forward migration: rewrite the unnamed inline CHECK (auto-named
-- provider_instances_protocol_check) to include the new member. Historical
-- migrations stay untouched; contract enum and this CHECK must move together
-- (enforced by tests/workspace.test.mjs reconciliation gate).

ALTER TABLE public.provider_instances DROP CONSTRAINT provider_instances_protocol_check;
ALTER TABLE public.provider_instances ADD CONSTRAINT provider_instances_protocol_check
  CHECK (protocol IN ('openai-compatible', 'anthropic', 'gemini', 'google-image', 'replicate', 'volces', 'metaso', 'dify-engine'));
