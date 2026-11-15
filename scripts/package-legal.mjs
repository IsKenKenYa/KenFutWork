import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LEGAL_DOCUMENTS = [
  ["LICENSE", "GPL-3.0.txt"],
  ["NOTICE.md", "NOTICE.md"],
  ["EULA.md", "EULA.md"],
  ["PRIVACY.md", "PRIVACY.md"],
  ["THIRD-PARTY-NOTICES.md", "THIRD-PARTY-NOTICES.md"],
  ["COPYRIGHT.md", "COPYRIGHT.md"],
  ["licenses/loomic-MIT.txt", "loomic-MIT.txt"],
];

const LEGAL_UPSTREAM = [
  ["apps/web/src/components/workbench/zcode/LICENSE", "zcode-LICENSE.txt"],
  ["apps/web/src/components/workbench/zcode/NOTICE.md", "zcode-NOTICE.md"],
  [
    "apps/web/src/components/workbench/zcode/THIRD-PARTY-NOTICES.md",
    "zcode-THIRD-PARTY-NOTICES.txt",
  ],
  [
    "apps/web/src/components/workbench/zcode/public/material-icons/LICENSE",
    "material-icon-theme-LICENSE.txt",
  ],
  ["patches/LICENSE-langchain.txt", "langchain-LICENSE.txt"],
  ["patches/LICENSE-sandbox-runtime.txt", "sandbox-runtime-LICENSE.txt"],
  ["licenses/tauri-dialog-MIT.txt", "tauri-dialog-MIT.txt"],
  ["licenses/rfd-MIT.txt", "rfd-MIT.txt"],
  [
    "packages/context-insights-ui/vendor/dsh-context/LICENSE",
    "dsh-context-LICENSE.txt",
  ],
  [
    "packages/context-insights-ui/vendor/deepseek-harness/LICENSE",
    "deepseek-harness-LICENSE.txt",
  ],
  ["packages/context-insights-ui/NOTICE", "context-insights-NOTICE.txt"],
  [
    "packages/context-insights-ui/来源清单.json",
    "context-insights-provenance.json",
  ],
];

/** 两个平台共用分发声明清单；缺少任一来源文件时终止出包。 */
export function stageLegalDocuments(root, release) {
  const legal = join(release, "legal");
  mkdirSync(join(legal, "upstream"), { recursive: true });
  for (const [source, name] of LEGAL_DOCUMENTS) {
    copyFileSync(join(root, source), join(legal, name));
  }
  for (const [source, name] of LEGAL_UPSTREAM) {
    copyFileSync(join(root, source), join(legal, "upstream", name));
  }
}
