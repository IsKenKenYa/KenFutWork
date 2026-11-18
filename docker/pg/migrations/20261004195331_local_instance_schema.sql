-- DEC-20：本地实例是数据所有者，接入客户端只作可空审计。
-- 尚无 release/真实用户：显式丢弃开发业务数据，不迁移旧账户或商业权益。
-- 历史迁移与执行账本保持原样；本地实例、客户端凭据以及 SDK/扩展独立 schema 保留。

TRUNCATE TABLE
  public.account_credentials, public.account_sessions, public.accounts,
  public.agent_runs, public.agent_turn_boundaries, public.api_tokens, public.app_config,
  public.asset_objects, public.background_jobs, public.brand_kit_assets, public.brand_kits,
  public.canvases, public.chat_messages, public.chat_sessions, public.code_attachments,
  public.code_ui_commands, public.code_ui_events, public.code_ui_outputs, public.code_ui_sessions,
  public.credit_balances, public.credit_transactions, public.daily_credit_claims,
  public.flow_credit_holds, public.home_discovery_cases, public.home_discovery_categories,
  public.home_example_categories, public.home_example_examples, public.mcp_servers,
  public.payment_events, public.plugin_storage, public.profiles, public.project_checkpoints,
  public.projects, public.provider_instances, public.provider_registry_revisions,
  public.skill_files, public.skills, public.subscriptions, public.task_works, public.usage_records,
  public.workspace_members, public.workspace_settings, public.workspace_skills, public.workspaces
  RESTART IDENTITY CASCADE;

-- 旧任务行已经丢弃，历史消息不得被自动重放；不删除 pgmq 结构或扩展。
DO $clear_legacy_queue_messages$
DECLARE queue_table text;
BEGIN
  FOREACH queue_table IN ARRAY ARRAY[
    'q_image_generation_jobs', 'a_image_generation_jobs',
    'q_video_generation_jobs', 'a_video_generation_jobs',
    'q_code_execution_jobs', 'a_code_execution_jobs'
  ] LOOP
    IF to_regclass(format('pgmq.%I', queue_table)) IS NOT NULL THEN
      EXECUTE format('TRUNCATE TABLE pgmq.%I RESTART IDENTITY', queue_table);
    END IF;
  END LOOP;
END
$clear_legacy_queue_messages$;

DROP TRIGGER IF EXISTS provider_registry_revision ON public.provider_instances;

-- 退役函数按历史定义查签名，不改不可变 SQL，也不动扩展拥有的函数。
DO $retire_product_functions$
DECLARE function_record record;
BEGIN
  FOR function_record IN
    SELECT namespace.nspname, proc.proname,
           pg_get_function_identity_arguments(proc.oid) AS arguments
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname IN ('public', 'private')
      AND proc.proname = ANY(ARRAY[
        'bootstrap_viewer', 'create_project_with_canvas', 'handle_new_user', 'is_platform_admin',
        'is_workspace_member', 'is_workspace_owner', 'is_project_member',
        'is_workspace_admin_or_owner', 'is_project_admin_or_owner',
        'prevent_profile_email_change', 'bootstrap_user_foundation', 'asset_object_project_matches_workspace',
        'init_workspace_skills', 'init_workspace_credits',
        'deduct_credits', 'refund_credits', 'claim_daily_credits', 'grant_plan_credits',
        'deduct_chat_credits', 'admin_adjust_credits', 'admin_users_overview',
        'flow_reserve_credits', 'flow_settle_credits', 'flow_refund_credits'
      ])
      AND NOT EXISTS (SELECT 1 FROM pg_depend AS dependency
        WHERE dependency.classid = 'pg_proc'::regclass AND dependency.objid = proc.oid
          AND dependency.deptype = 'e')
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %I.%I(%s) CASCADE', function_record.nspname,
                   function_record.proname, function_record.arguments);
  END LOOP;
END
$retire_product_functions$;

-- 仅移除指向退役身份表的 FK。Project/Task/根子会话/TaskWork 的复合 FK 原样保留。
DO $detach_retired_identity_foreign_keys$
DECLARE foreign_key record;
BEGIN
  FOR foreign_key IN
    SELECT constraint_record.conrelid::regclass AS relation, constraint_record.conname
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.contype = 'f'
      AND constraint_record.confrelid IN (
        'public.accounts'::regclass, 'public.profiles'::regclass, 'public.workspaces'::regclass
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', foreign_key.relation, foreign_key.conname);
  END LOOP;
END
$detach_retired_identity_foreign_keys$;

DROP VIEW IF EXISTS auth.users;
DROP TABLE public.account_credentials, public.account_sessions, public.api_tokens,
  public.workspace_members, public.profiles, public.workspaces, public.accounts,
  public.subscriptions, public.credit_balances, public.credit_transactions,
  public.daily_credit_claims, public.payment_events, public.flow_credit_holds CASCADE;
DROP TYPE public.workspace_type, public.workspace_member_role,
  public.subscription_plan, public.billing_period, public.credit_transaction_type;

-- auth.uid 是历史供给前导的产品兼容函数。空 schema 才删除，不级联清除未知对象。
DROP FUNCTION IF EXISTS auth.uid() CASCADE;
DO $remove_empty_auth_schema$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'auth'::regnamespace)
     AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'auth'::regnamespace)
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'auth'::regnamespace) THEN
    EXECUTE 'DROP SCHEMA auth RESTRICT';
  END IF;
END
$remove_empty_auth_schema$;

-- 列改名保留原来的复合唯一键、FK 和 CHECK 表达式；审计绝不再替代资源所有权。
DO $rename_instance_columns$
DECLARE column_record record;
BEGIN
  FOR column_record IN
    SELECT relation.oid::regclass AS relation, attribute.attname
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND attribute.attname = 'workspace_id'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME COLUMN workspace_id TO instance_id', column_record.relation);
  END LOOP;
END
$rename_instance_columns$;

ALTER TABLE public.workspace_settings RENAME TO instance_settings;
ALTER TABLE public.workspace_skills RENAME TO instance_skills;
ALTER TABLE public.instance_settings ALTER COLUMN default_model SET DEFAULT '';
COMMENT ON TABLE public.instance_settings IS '本地实例设置，包含 runtime_governance 与原 Code 参数';

ALTER TABLE public.brand_kits RENAME COLUMN user_id TO instance_id;
ALTER TABLE public.skills ADD COLUMN instance_id uuid NOT NULL;
ALTER TABLE public.usage_records RENAME COLUMN user_id TO access_client_id;
ALTER TABLE public.usage_records ALTER COLUMN access_client_id DROP NOT NULL;
ALTER TABLE public.code_attachments DROP COLUMN user_id;
ALTER TABLE public.code_attachments ADD COLUMN created_by_client_id uuid;

DO $rename_client_audit_columns$
DECLARE column_record record;
BEGIN
  FOR column_record IN
    SELECT relation.oid::regclass AS relation, relation.relname, attribute.attname
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND attribute.attname IN ('created_by', 'installed_by')
  LOOP
    IF column_record.relname = 'provider_instances' THEN
      EXECUTE format('ALTER TABLE %s DROP COLUMN %I', column_record.relation, column_record.attname);
    ELSE
      EXECUTE format('ALTER TABLE %s RENAME COLUMN %I TO %I', column_record.relation,
        column_record.attname, column_record.attname || '_client_id');
      EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP NOT NULL', column_record.relation,
        column_record.attname || '_client_id');
    END IF;
  END LOOP;
END
$rename_client_audit_columns$;

-- 附件墓碑仍只保留最小生命周期身份；账号别名不进入持久记录。
DO $replace_attachment_tombstone_check$
DECLARE constraint_record record;
BEGIN
  FOR constraint_record IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.code_attachments'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) LIKE '%userId%' OR pg_get_constraintdef(oid) LIKE '%workspaceId%')
  LOOP
    EXECUTE format('ALTER TABLE public.code_attachments DROP CONSTRAINT %I', constraint_record.conname);
  END LOOP;
END
$replace_attachment_tombstone_check$;
ALTER TABLE public.code_attachments ADD CONSTRAINT code_attachments_tombstone_identity CHECK (
  status <> 'aborted' OR record - ARRAY[
    'status', 'key', 'instanceId', 'projectId', 'taskId', 'sessionId', 'createdByClientId'
  ]::text[] = '{}'::jsonb
);

-- Code 检查点不再保留无消费方的旧画布兼容列。
ALTER TABLE public.project_checkpoints DROP COLUMN legacy_canvas_id;
ALTER TABLE public.project_checkpoints
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN task_id SET NOT NULL,
  ALTER COLUMN root_directory SET NOT NULL;

-- 本地供应商的 Key 只在数据目录文件中；库内仅有引用与非秘密变化信号。
ALTER TABLE public.provider_instances
  DROP CONSTRAINT provider_instances_scope_workspace_chk,
  DROP CONSTRAINT provider_instances_scope_check,
  DROP COLUMN encrypted_api_key,
  ADD COLUMN api_key_ref text,
  ADD COLUMN credential_revision bigint NOT NULL DEFAULT 0 CHECK (credential_revision >= 0),
  ALTER COLUMN scope SET DEFAULT 'local',
  ALTER COLUMN instance_id SET NOT NULL,
  ADD CONSTRAINT provider_instances_scope_check CHECK (scope = 'local');
DROP INDEX IF EXISTS public.provider_instances_scope_idx;
COMMENT ON TABLE public.provider_instances IS '本地 BYOK 供应商配置，API Key 明文保存在数据目录文件';
COMMENT ON COLUMN public.provider_instances.api_key_ref IS '本地凭据文件的条目引用；普通目录不返回明文 Key';
COMMENT ON COLUMN public.provider_instances.credential_revision IS '真实 Key 变化的非秘密修订信号；同值保存不推进';

ALTER TABLE public.plugin_storage RENAME COLUMN value_ciphertext TO value_text;
COMMENT ON TABLE public.plugin_storage IS '按本地实例与插件隔离的持久文本存储，卸载插件清除该插件记录';
ALTER TABLE public.mcp_servers
  DROP CONSTRAINT mcp_servers_name_key,
  ADD COLUMN instance_id uuid NOT NULL,
  ADD CONSTRAINT mcp_servers_instance_name_key UNIQUE (instance_id, name);
COMMENT ON TABLE public.mcp_servers IS '本地实例的 MCP 配置；准入由本机接入凭据验证';

-- 所有直接持有 instance_id 的业务表真实引用单主体根；不靠应用谓词代替 FK。
DO $attach_local_instance_foreign_keys$
DECLARE column_record record;
BEGIN
  FOR column_record IN
    SELECT relation.oid AS relation_oid, relation.oid::regclass AS relation,
           relation.relname, attribute.attnum
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
      AND attribute.attnum > 0 AND NOT attribute.attisdropped AND attribute.attname = 'instance_id'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint AS foreign_key
      WHERE foreign_key.contype = 'f' AND foreign_key.conrelid = column_record.relation_oid
        AND foreign_key.conkey = ARRAY[column_record.attnum]::smallint[]
        AND foreign_key.confrelid = 'public.local_instances'::regclass) THEN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (instance_id) REFERENCES public.local_instances(id) ON DELETE CASCADE',
        column_record.relation, column_record.relname || '_instance_id_fkey');
    END IF;
  END LOOP;
END
$attach_local_instance_foreign_keys$;

DO $attach_client_audit_foreign_keys$
DECLARE column_record record;
BEGIN
  FOR column_record IN
    SELECT relation.oid::regclass AS relation, relation.relname, attribute.attname
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND attribute.attname IN ('created_by_client_id', 'installed_by_client_id', 'access_client_id')
  LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.local_access_clients(id) ON DELETE SET NULL',
      column_record.relation, column_record.relname || '_' || column_record.attname || '_fkey', column_record.attname);
  END LOOP;
END
$attach_client_audit_foreign_keys$;

-- 退役 Code execution 的旧 Job enum 标签；Code 后台工作仍由 TaskWork 承接。
ALTER TABLE public.background_jobs ALTER COLUMN job_type TYPE text USING job_type::text;
DROP TYPE public.background_job_type;
CREATE TYPE public.background_job_type AS ENUM ('image_generation', 'video_generation');
ALTER TABLE public.background_jobs ALTER COLUMN job_type TYPE public.background_job_type USING job_type::public.background_job_type;
ALTER TABLE public.background_jobs DROP COLUMN credits_cost, DROP COLUMN credits_transaction_id;

-- 聚合 revision 仍由提交后的实际配置变更推进；探测、时间戳及同值配置不推进。
CREATE OR REPLACE FUNCTION public.advance_provider_registry_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_instance uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND
    (OLD.name, OLD.protocol, OLD.base_url, OLD.api_key_ref, OLD.credential_revision,
     OLD.models, OLD.compat, OLD.headers, OLD.enabled, OLD.code_ui_config)
      IS NOT DISTINCT FROM
    (NEW.name, NEW.protocol, NEW.base_url, NEW.api_key_ref, NEW.credential_revision,
     NEW.models, NEW.compat, NEW.headers, NEW.enabled, NEW.code_ui_config) THEN
    RETURN NULL;
  END IF;
  target_instance := CASE WHEN TG_OP = 'DELETE' THEN OLD.instance_id ELSE NEW.instance_id END;
  IF EXISTS (SELECT 1 FROM public.local_instances WHERE id = target_instance) THEN
    INSERT INTO public.provider_registry_revisions (instance_id, revision)
    VALUES (target_instance, 1)
    ON CONFLICT (instance_id) DO UPDATE SET revision = public.provider_registry_revisions.revision + 1;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER provider_registry_revision
AFTER INSERT OR UPDATE OR DELETE ON public.provider_instances
FOR EACH ROW EXECUTE FUNCTION public.advance_provider_registry_revision();

-- 只改约束/索引名称，不重建已有 lineage、代际、幂等或唯一性表达式。
DO $rename_instance_constraint_names$
DECLARE constraint_record record;
BEGIN
  FOR constraint_record IN
    SELECT conrelid::regclass AS relation, conname FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND conname LIKE '%workspace%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', constraint_record.relation,
      constraint_record.conname, replace(constraint_record.conname, 'workspace', 'instance'));
  END LOOP;
END
$rename_instance_constraint_names$;
DO $rename_instance_index_names$
DECLARE index_record record;
BEGIN
  FOR index_record IN
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname LIKE '%workspace%'
  LOOP
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', index_record.indexname,
      replace(index_record.indexname, 'workspace', 'instance'));
  END LOOP;
END
$rename_instance_index_names$;

-- 新的最终目录不得继续依赖已退役账户/计费函数或身份字段。
DO $assert_retired_schema_removed$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc AS proc JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname IN ('public', 'private') AND proc.prokind = 'f'
      AND proc.prosrc ~* '(public\.(accounts|profiles|workspaces|workspace_members|subscriptions|credit_balances|credit_transactions|daily_credit_claims|payment_events|flow_credit_holds)|workspace_id|user_id|encrypted_api_key|value_ciphertext|auth\.uid)'
      AND NOT EXISTS (SELECT 1 FROM pg_depend AS dependency WHERE dependency.classid = 'pg_proc'::regclass
        AND dependency.objid = proc.oid AND dependency.deptype = 'e')
  ) THEN
    RAISE EXCEPTION '最终函数目录仍引用已退役的身份或商业对象';
  END IF;
END
$assert_retired_schema_removed$;
