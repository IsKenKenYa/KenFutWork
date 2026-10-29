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

/** 登记顺序即信息页展示顺序：office 三件套在前（用户核心诉求），其余按类别跟后。
 * gridcraft 已锚定发布（v0.11.1，sha256 来自上游 SHA256SUMS.txt，2026-10-25 实测
 * 下载核对一致）；全部 12 个编辑器均锚定各自最新发布（2026-10-25 逐仓核对
 * SHA256SUMS.txt），未锚定项不存在——不给无锚定的假下载按钮。*/
const WORK_EDITOR_REGISTRY: readonly WorkEditorRegistration[] = [
  {
    id: "gridcraft",
    title: "表格",
    category: "office",
    repo: "https://github.com/storytold/gridcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.11.1",
      asset: "gridcraft-web-0.11.1.zip",
      bytes: 7571063,
      sha256:
        "b9491325936457cebd874656becbe5d189fbd2039db6798d9d7f5c5e0190715e",
      url: "https://github.com/storytold/gridcraft/releases/download/v0.11.1/gridcraft-web-0.11.1.zip",
    },
  },
  {
    id: "wordcraft",
    title: "文档",
    category: "office",
    repo: "https://github.com/storytold/wordcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.11.0",
      asset: "wordcraft-web-0.11.0.zip",
      bytes: 17532588,
      sha256:
        "b87db9cf806ec7172c60be570f96b7e245cafced14d5c419300d9938302742c7",
      url: "https://github.com/storytold/wordcraft/releases/download/v0.11.0/wordcraft-web-0.11.0.zip",
    },
  },
  {
    id: "deckcraft",
    title: "演示",
    category: "office",
    repo: "https://github.com/storytold/deckcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.11.1",
      asset: "deckcraft-web-0.11.1.zip",
      bytes: 11086170,
      sha256:
        "f802d9d6b8b1f97215eeadd048f5f44f9cbc60d4888ca622fa9dcdaa8c12ddaa",
      url: "https://github.com/storytold/deckcraft/releases/download/v0.11.1/deckcraft-web-0.11.1.zip",
    },
  },
  {
    id: "photocraft",
    title: "图片",
    category: "image",
    repo: "https://github.com/storytold/photocraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.15.1",
      asset: "photocraft-web-0.15.1.zip",
      bytes: 12058467,
      sha256:
        "987251cb84c375130fa3624fa1e1dbbea24b062192121b594c9e538d05ea9109",
      url: "https://github.com/storytold/photocraft/releases/download/v0.15.1/photocraft-web-0.15.1.zip",
    },
  },
  {
    id: "lightcraft",
    title: "照片",
    category: "image",
    repo: "https://github.com/storytold/lightcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.13.0",
      asset: "lightcraft-web-0.13.0.zip",
      bytes: 71032666,
      sha256:
        "80d8434f9917e7384e1241a7a2fa8f52b07f8c6006dab9c5ab6ace900128e92f",
      url: "https://github.com/storytold/lightcraft/releases/download/v0.13.0/lightcraft-web-0.13.0.zip",
    },
  },
  {
    id: "vectorcraft",
    title: "矢量",
    category: "image",
    repo: "https://github.com/storytold/vectorcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.16.0",
      asset: "vectorcraft-web-0.16.0.zip",
      bytes: 28447363,
      sha256:
        "5041d69b82a6d7bc39527a15bc42ae8e3e19a92eb0b72efb112aa26aa25efc23",
      url: "https://github.com/storytold/vectorcraft/releases/download/v0.16.0/vectorcraft-web-0.16.0.zip",
    },
  },
  {
    id: "filmcraft",
    title: "视频",
    category: "video",
    repo: "https://github.com/storytold/filmcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.12.0",
      asset: "filmcraft-web-0.12.0.zip",
      bytes: 13434151,
      sha256:
        "c62658f33781767909e180b464c1875ccf41e18465de3cdd1acd135381b8be74",
      url: "https://github.com/storytold/filmcraft/releases/download/v0.12.0/filmcraft-web-0.12.0.zip",
    },
  },
  {
    id: "effectcraft",
    title: "动效",
    category: "video",
    repo: "https://github.com/storytold/effectcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.16.0",
      asset: "effectcraft-web-0.16.0.zip",
      bytes: 19332740,
      sha256:
        "b6d08ea9168dbca3257c4f68b658e1ec37e4a83718312e420c1cb99f38868a74",
      url: "https://github.com/storytold/effectcraft/releases/download/v0.16.0/effectcraft-web-0.16.0.zip",
    },
  },
  {
    id: "designcraft",
    title: "排版",
    category: "layout",
    repo: "https://github.com/storytold/designcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.13.0",
      asset: "designcraft-web-0.13.0.zip",
      bytes: 22741069,
      sha256:
        "46616ffbefab157c30803c54f39a8769e0d7a57bef9e99be8d104eccffb92312",
      url: "https://github.com/storytold/designcraft/releases/download/v0.13.0/designcraft-web-0.13.0.zip",
    },
  },
  {
    id: "pdfcraft",
    title: "PDF",
    category: "pdf",
    repo: "https://github.com/storytold/pdfcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.13.0",
      asset: "pdfcraft-web-0.13.0.zip",
      bytes: 15702351,
      sha256:
        "b16bb14222f371bc5c8da9dc2ee39c77c35f748ffd953d738e4cb3241287b3c8",
      url: "https://github.com/storytold/pdfcraft/releases/download/v0.13.0/pdfcraft-web-0.13.0.zip",
    },
  },
  {
    id: "soundcraft",
    title: "音频",
    category: "audio",
    repo: "https://github.com/storytold/soundcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.12.1",
      asset: "soundcraft-web-0.12.1.zip",
      bytes: 5959717,
      sha256:
        "e37f4d6643668a04f27f32c66353edab52edaaf982f61c89c674221ffa4189c9",
      url: "https://github.com/storytold/soundcraft/releases/download/v0.12.1/soundcraft-web-0.12.1.zip",
    },
  },
  {
    id: "cadcraft",
    title: "CAD",
    category: "cad",
    repo: "https://github.com/storytold/cadcraft",
    license: "MIT OR Apache-2.0",
    mount: WASM_MOUNT,
    pinned: {
      version: "0.12.0",
      asset: "cadcraft-web-0.12.0.zip",
      bytes: 8702006,
      sha256:
        "8fe310d78388220aedcad2f9072bf59ab2de8262530615ff8bbef39eb014fe14",
      url: "https://github.com/storytold/cadcraft/releases/download/v0.12.0/cadcraft-web-0.12.0.zip",
    },
  },
  {
    // 自建的 web 编辑器（KiCad 没有 web 构建）：站点随仓库分发、启动时落位，
    // 所以 `pinned` 为 null（没有要下载的上游包），`installed` 由落位事实决定。
    id: "kicad",
    title: "电路",
    category: "eda",
    repo: "https://gitlab.com/kicad/code/kicad",
    license: "GPL-3.0-or-later",
    mount: WASM_MOUNT,
    pinned: null,
  },
];

export function listWorkEditorRegistrations(): readonly WorkEditorRegistration[] {
  return WORK_EDITOR_REGISTRY;
}
