-- 插件存储（插件互操作缝的新能力面 `storage`）。
--
-- 用途：插件把需要跨重启存活的状态（第三方集成的会话凭证等）存在本表。
-- 值一律经 SecretStore（AES-256-GCM，密钥来自 KENFUTWORK_CREDENTIAL_SECRET）
-- 加密后落库，HTTP 面永不回显——与 BYOK 凭证同一条红线。
--
-- 隔离：按「工作区 + 插件 id + 键」三元组；所有读写经持久化缝的工作区作用域
-- （FORM-9：应用层强制 `workspace_id` 谓词，漏写即失败）。
-- 生命周期：插件「停用」保留数据；「卸载」清空该插件全部记录（purgePlugin）。
create table if not exists public.plugin_storage (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  plugin_id text not null,
  entry_key text not null,
  value_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, plugin_id, entry_key)
);

-- 卸载清理（跨工作区按 plugin_id 删除）与「某插件用了多大空间」的排查都走这条索引
create index if not exists plugin_storage_plugin_idx
  on public.plugin_storage(plugin_id);

comment on table public.plugin_storage is
  '插件键值存储：值加密落库、按工作区隔离；卸载插件即清空该插件全部记录';
