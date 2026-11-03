import { mkdtempSync, type writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ensureOpenDesignAutoSecret,
  parseOpenDesignConfigText,
  readOpenDesignFileConfig,
  resolveOpenDesignConfigView,
  serializeOpenDesignConfigText,
  writeOpenDesignFileConfig,
} from "./config-store.js";

describe("桌面承载配置文件（open-design.env）", () => {
  it("解析只认白名单两键：注释/空行/未知键/空值全忽略", () => {
    const parsed = parseOpenDesignConfigText(
      [
        "# 注释",
        "",
        "KENFUTWORK_OPEN_DESIGN_FRONTEND_URL=http://127.0.0.1:7456",
        "KENFUTWORK_OPEN_DESIGN_EMBED_SECRET=paired",
        "PATH=/evil",
        "KENFUTWORK_EMBEDDED_PG=1",
        "EMPTY=",
        "NO_EQUALS_LINE",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      frontendUrl: "http://127.0.0.1:7456",
      embedSecret: "paired",
    });
  });

  it("序列化→解析往返一致；两键全空只剩注释头", () => {
    const round = parseOpenDesignConfigText(
      serializeOpenDesignConfigText({
        frontendUrl: "http://localhost:7456",
        embedSecret: "s3cret",
      }),
    );
    expect(round).toEqual({
      frontendUrl: "http://localhost:7456",
      embedSecret: "s3cret",
    });
    expect(
      parseOpenDesignConfigText(
        serializeOpenDesignConfigText({
          frontendUrl: null,
          embedSecret: null,
        }),
      ),
    ).toEqual({ frontendUrl: null, embedSecret: null });
  });

  it("读写落盘往返；文件缺失读为空（默认关闭不是错误）", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-od-cfg-"));
    expect(readOpenDesignFileConfig({ dataDir })).toEqual({
      frontendUrl: null,
      embedSecret: null,
    });
    writeOpenDesignFileConfig({
      dataDir,
      config: { frontendUrl: "http://127.0.0.1:7456", embedSecret: "p1" },
    });
    expect(readOpenDesignFileConfig({ dataDir })).toEqual({
      frontendUrl: "http://127.0.0.1:7456",
      embedSecret: "p1",
    });
  });

  it("生效判定：env 在场 source=env；只有文件 source=file 且待重启；全空 none", () => {
    expect(
      resolveOpenDesignConfigView({
        file: { frontendUrl: "http://127.0.0.1:7456", embedSecret: null },
        envFrontendUrl: "http://127.0.0.1:7456",
      }),
    ).toMatchObject({ source: "env", restartRequired: false });

    expect(
      resolveOpenDesignConfigView({
        file: { frontendUrl: "http://127.0.0.1:7456", embedSecret: "x" },
      }),
    ).toMatchObject({ source: "file", restartRequired: true });

    expect(
      resolveOpenDesignConfigView({
        file: { frontendUrl: null, embedSecret: null },
      }),
    ).toMatchObject({ source: "none", restartRequired: false });
  });

  it("自动密钥：首次生成落盘，之后复用同一把", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-od-secret-"));
    const writes: Array<{
      path: string;
      data: string;
      mode?: number | undefined;
    }> = [];
    const created = ensureOpenDesignAutoSecret({
      dataDir,
      createImpl: () => "auto-generated-secret",
      writeImpl: ((path, data, options) =>
        writes.push({
          path: String(path),
          data: String(data),
          mode: (options as { mode?: number })?.mode,
        })) as typeof writeFileSync,
    });
    expect(created).toBe("auto-generated-secret");
    // 明文凭据：权限必须收口 0600，路径在数据目录 config 下
    expect(writes[0]?.mode).toBe(0o600);
    expect(writes[0]?.path).toBe(
      join(dataDir, "config", "open-design.embed-secret"),
    );

    const real = ensureOpenDesignAutoSecret({ dataDir });
    const again = ensureOpenDesignAutoSecret({ dataDir });
    expect(again).toBe(real);
    expect(again.length).toBeGreaterThan(20);
  });
});
