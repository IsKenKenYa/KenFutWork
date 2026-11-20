-- Skill Files: multi-file skill content storage (scripts/, references/, assets/)
-- Supports the skills.sh import pipeline and structured skill packages.

-- =============================================================================
-- 1. Extend skills table with import metadata
-- =============================================================================

ALTER TABLE public.skills
  ADD COLUMN IF NOT EXISTS source_url text,       -- original import URL (e.g., skills.sh link)
  ADD COLUMN IF NOT EXISTS package_name text;      -- npm package name from skills.sh registry

COMMENT ON COLUMN public.skills.source_url IS 'Original URL the skill was imported from';
COMMENT ON COLUMN public.skills.package_name IS 'npm-style package name from the skills.sh registry';

-- =============================================================================
-- 2. skill_files table
-- =============================================================================

CREATE TABLE public.skill_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES public.skills(id) ON DELETE CASCADE,
  file_path text NOT NULL,                         -- relative path, e.g. "scripts/analyze.py"
  content text NOT NULL,                           -- raw file content
  mime_type text NOT NULL DEFAULT 'text/plain',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Each skill can only have one file at a given path
  UNIQUE (skill_id, file_path),

  -- Only allow files under known directories
  CHECK (file_path ~ '^(scripts|references|assets)/')
);

COMMENT ON TABLE public.skill_files IS 'Stores multi-file skill content (scripts, references, assets)';

-- Index for efficient lookup by parent skill
CREATE INDEX skill_files_skill_id_idx ON public.skill_files (skill_id);

-- =============================================================================
-- 3. RLS Policies
-- =============================================================================

ALTER TABLE public.skill_files ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users can read files for skills they can see
-- (system/community skills are public; user skills are visible only to owner)
CREATE POLICY skill_files_select ON public.skill_files
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.skills s
      WHERE s.id = skill_files.skill_id
        AND (s.source IN ('system', 'community') OR s.created_by = auth.uid())
    )
  );

-- INSERT: only for user-owned skills
CREATE POLICY skill_files_insert ON public.skill_files
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.skills s
      WHERE s.id = skill_files.skill_id
        AND s.source = 'user'
        AND s.created_by = auth.uid()
    )
  );

-- UPDATE: only for user-owned skills
CREATE POLICY skill_files_update ON public.skill_files
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.skills s
      WHERE s.id = skill_files.skill_id
        AND s.source = 'user'
        AND s.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.skills s
      WHERE s.id = skill_files.skill_id
        AND s.source = 'user'
        AND s.created_by = auth.uid()
    )
  );

-- DELETE: only for user-owned skills
CREATE POLICY skill_files_delete ON public.skill_files
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.skills s
      WHERE s.id = skill_files.skill_id
        AND s.source = 'user'
        AND s.created_by = auth.uid()
    )
  );

-- Service role: unrestricted access (used by server/workers for system skill imports)
CREATE POLICY skill_files_service ON public.skill_files
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- =============================================================================
-- 4. updated_at trigger (reuse existing function)
-- =============================================================================

CREATE TRIGGER skill_files_updated_at
  BEFORE UPDATE ON public.skill_files
  FOR EACH ROW EXECUTE FUNCTION public.update_skills_updated_at();
