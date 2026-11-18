-- 配置pointer仍由native持有；此字段只记录上次已完成持久路径绑定的物理根。
ALTER TABLE public.local_instances ADD COLUMN last_data_dir text;
COMMENT ON COLUMN public.local_instances.last_data_dir IS '启动期事务完成后的规范数据根；仅用于检测迁移/复制恢复，不作为配置来源';
