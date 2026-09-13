/**
 * JSON 值的递归类型（原由 Supabase 生成类型文件导出）。
 *
 * 生成类型已随 Supabase SDK 一起移除（M1.5），但 `Json` 本身与任何供应商无关——
 * 它只是「可安全落 jsonb 的值」的描述，故独立成模块继续导出。
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];
