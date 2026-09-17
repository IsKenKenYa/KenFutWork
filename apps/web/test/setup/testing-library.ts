import { configure } from "@testing-library/react";

/**
 * 全仓测试的异步查询预算。
 *
 * 背景：组件用例（面板 / 图谱 / 权限等）单个跑都在 1-3 秒，但 `turbo run test` 会把各包并行拉起来，
 * 本机高负载时默认 1 秒的异步查询预算会偶发超时（表现为「单跑绿、全量红」；
 * 逐个文件加超时是打地鼠）。这里统一给到 5 秒：真出错仍然会失败，只是不再被机器负载判红。
 */
configure({ asyncUtilTimeout: 5000 });
