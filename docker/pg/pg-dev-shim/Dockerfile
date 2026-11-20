# 纯 Postgres 开发库镜像（M1.5）：官方镜像 + pgmq 兼容 shim 扩展。
#
# 为什么需要 shim：历史迁移 `20260325200000_background_jobs.sql` 里有
# `CREATE EXTENSION IF NOT EXISTS pgmq;`（已执行迁移不可改），而官方 postgres 镜像不带
# PGMQ（Windows/自托管都拿不到预编译版本，FORM-2）。这里把**只含 `pgmq.create(queue)`**
# 的最小 SQL 打包成扩展，让迁移链能在纯 PG 上完整重放。
#
# **它只是「历史可重放」的兼容层，不是队列实现**：本地开发把 `LOOMIC_QUEUE_DRIVER` 设为
# `in-process`（M3.2 的桌面形态），不经过本 shim；自托管生产应装**真 pgmq**（或后续接入
# 外部队列），那时本扩展会被真扩展取代（同名，`CREATE EXTENSION pgmq` 已存在则跳过）。
FROM postgres:17-alpine

COPY pgmq.control /usr/local/share/postgresql/extension/pgmq.control
COPY pgmq--1.0.sql /usr/local/share/postgresql/extension/pgmq--1.0.sql
