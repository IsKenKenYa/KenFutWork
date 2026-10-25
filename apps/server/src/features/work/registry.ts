import type { WorkEditor, WorkEditorMount } from "@kenfutwork/shared";

/**
 * 编辑器扩展包注册表（W1：元数据 + 挂载点，先接线后下载——WD-3）。
 *
 * 内容为 ArtCraft（storytold）系列的**事实登记**：许可证、上游与类别以各上游
 * README / LICENSE 为准（2026-10-09 全量复核、2026-10-24 抽查复核，见
 * 《work 模式集成规划》§3）。注册表不含 `installed`——落位事实由数据目录检查
 * 计算（`listWorkEditors`），注册表常量与运行时事实分离。
 */

export type WorkEditorRegistration = Omit<WorkEditor, "installed">;

const WASM_MOUNT: WorkEditorMount = "wasm-iframe";

/** 登记顺序即信息页展示顺序：office 三件套在前（用户核心诉求），其余按类别跟后。 */
const WORK_EDITOR_REGISTRY: readonly WorkEditorRegistration[] = [
  {
    id: "gridcraft",
    title: "表格",
    category: "office",
    repo: "https://github.com/storytold/gridcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "wordcraft",
    title: "文档",
    category: "office",
    repo: "https://github.com/storytold/wordcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "deckcraft",
    title: "演示",
    category: "office",
    repo: "https://github.com/storytold/deckcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "photocraft",
    title: "图片",
    category: "image",
    repo: "https://github.com/storytold/photocraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "lightcraft",
    title: "照片",
    category: "image",
    repo: "https://github.com/storytold/lightcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "vectorcraft",
    title: "矢量",
    category: "image",
    repo: "https://github.com/storytold/vectorcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "filmcraft",
    title: "视频",
    category: "video",
    repo: "https://github.com/storytold/filmcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "effectcraft",
    title: "动效",
    category: "video",
    repo: "https://github.com/storytold/effectcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "designcraft",
    title: "排版",
    category: "layout",
    repo: "https://github.com/storytold/designcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "pdfcraft",
    title: "PDF",
    category: "pdf",
    repo: "https://github.com/storytold/pdfcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "soundcraft",
    title: "音频",
    category: "audio",
    repo: "https://github.com/storytold/soundcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
  {
    id: "cadcraft",
    title: "CAD",
    category: "cad",
    repo: "https://github.com/storytold/cadcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
  },
];

export function listWorkEditorRegistrations(): readonly WorkEditorRegistration[] {
  return WORK_EDITOR_REGISTRY;
}
