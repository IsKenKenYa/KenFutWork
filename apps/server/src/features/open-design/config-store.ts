import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 桌面承载配置文件（`<dataDir>/config/open-design.env`）的读写与生效判定。
 *
 * 文件格式与 Tauri 侧 `open_design_config_env`（§205）同一约定：`KEY=VALUE` 行、
 * 白名单两键、`#` 注释——跨语言两侧各有一份极简解析（各自带测试），不共享代码。
 * 权限口径：文件 0600、目录 0700（本地明文凭据，DEC-7）。
 */

export const OPEN_DESIGN_CONFIG_KEYS = [
  "KENFUTWORK_OPEN_DESIGN_FRONTEND_URL",
  "KENFUTWORK_OPEN_DESIGN_EMBED_SECRET",
] as const;

export interface OpenDesignFileConfig {
  frontendUrl: string | null;
  embedSecret: string | null;
}

export const EMPTY_FILE_CONFIG: OpenDesignFileConfig = {
  frontendUrl: null,
  embedSecret: null,
};

const KEY_TO_FIELD: Record<string, keyof OpenDesignFileConfig> = {
  KENFUTWORK_OPEN_DESIGN_FRONTEND_URL: "frontendUrl",
  KENFUTWORK_OPEN_DESIGN_EMBED_SECRET: "embedSecret",
};

/** 解析文件文本：只认白名单键；注释/空行/未知键/空值一律忽略。 */
export function parseOpenDesignConfigText(text: string): OpenDesignFileConfig {
  const out: OpenDesignFileConfig = { frontendUrl: null, embedSecret: null };
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const field = KEY_TO_FIELD[key];
    if (field && value) out[field] = value;
  }
  return out;
}

export function serializeOpenDesignConfigText(
  config: OpenDesignFileConfig,
): string {
  const lines = [
    "# KenFutWork OpenDesign 承载配置（桌面设置页写入；改后重启桌面生效）",
  ];
  if (config.frontendUrl) {
    lines.push(`${OPEN_DESIGN_CONFIG_KEYS[0]}=${config.frontendUrl}`);
  }
  if (config.embedSecret) {
    lines.push(`${OPEN_DESIGN_CONFIG_KEYS[1]}=${config.embedSecret}`);
  }
  return `${lines.join("\n")}\n`;
}

export function openDesignConfigPath(dataDir: string): string {
  return join(dataDir, "config", "open-design.env");
}

/** 读文件配置；文件不存在 = 空配置（默认关闭，不是错误）。 */
export function readOpenDesignFileConfig(input: {
  dataDir: string;
  readImpl?: typeof readFileSync;
}): OpenDesignFileConfig {
  const read = input.readImpl ?? readFileSync;
  try {
    return parseOpenDesignConfigText(
      read(openDesignConfigPath(input.dataDir), "utf8"),
    );
  } catch {
    return { ...EMPTY_FILE_CONFIG };
  }
}

/** 原子性要求低（两行文本），但权限必须收口：0600/0700。 */
export function writeOpenDesignFileConfig(input: {
  dataDir: string;
  config: OpenDesignFileConfig;
  writeImpl?: typeof writeFileSync;
  mkdirImpl?: typeof mkdirSync;
}): void {
  const write = input.writeImpl ?? writeFileSync;
  const mkdir = input.mkdirImpl ?? mkdirSync;
  mkdir(join(input.dataDir, "config"), { recursive: true, mode: 0o700 });
  write(
    openDesignConfigPath(input.dataDir),
    serializeOpenDesignConfigText(input.config),
    { mode: 0o600 },
  );
}

/**
 * GET 响应的生效判定：env（进程实际读到的）> file（重启后才会生效）> none。
 * `restartRequired`：文件值与进程生效值不一致——UI 据此提示「重启生效」。
 */
export function resolveOpenDesignConfigView(input: {
  file: OpenDesignFileConfig;
  /** 进程 env 的生效值（装配期定形；未配为 undefined）。 */
  envFrontendUrl?: string | undefined;
  envSecret?: string | undefined;
}): {
  frontendUrl: string | null;
  embedSecret: string | null;
  restartRequired: boolean;
  source: "env" | "file" | "none";
} {
  const envActive = Boolean(input.envFrontendUrl?.trim());
  const frontendUrl = input.file.frontendUrl;
  const embedSecret = input.file.embedSecret;
  const restartRequired =
    !envActive &&
    (frontendUrl !== null || embedSecret !== null) &&
    (frontendUrl !== (input.envFrontendUrl ?? null) ||
      embedSecret !== (input.envSecret ?? null));
  return {
    frontendUrl,
    embedSecret,
    restartRequired,
    source: envActive ? "env" : frontendUrl ? "file" : "none",
  };
}
