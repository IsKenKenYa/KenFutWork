import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KicadWorker } from "./worker.js";

/**
 * KiCad 安装位置只有两个来源：显式 `KENFUTWORK_KICAD_APP`，或实例数据目录里的便携解包目录。
 * 这条锁定「没装 KiCad 时不误报可用、装了以后能被找到」。
 */

const previous = process.env.KENFUTWORK_KICAD_APP;
afterEach(() => {
  if (previous === undefined) delete process.env.KENFUTWORK_KICAD_APP;
  else process.env.KENFUTWORK_KICAD_APP = previous;
});

function portableInstall(dataDir: string, exe: string): void {
  const bin = join(dataDir, "runtime", "kicad", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, exe), "");
}

describe("KiCad 安装位置", () => {
  it("默认认实例数据目录里的便携解包（bin/kicad-cli.exe）", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-kicad-"));
    delete process.env.KENFUTWORK_KICAD_APP;
    const worker = new KicadWorker(dataDir);
    expect(worker.kicadAppDir()).toBe(join(dataDir, "runtime", "kicad"));
    expect(worker.kicadInstalled()).toBe(false);
    portableInstall(dataDir, "kicad-cli.exe");
    expect(worker.kicadInstalled()).toBe(true);
  });

  it("KENFUTWORK_KICAD_APP 优先于便携目录", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-kicad-"));
    const custom = mkdtempSync(join(tmpdir(), "kfw-kicad-app-"));
    portableInstall(dataDir, "kicad-cli.exe");
    process.env.KENFUTWORK_KICAD_APP = custom;
    const worker = new KicadWorker(dataDir);
    expect(worker.kicadAppDir()).toBe(custom);
    expect(worker.kicadInstalled()).toBe(false);
  });

  it("macOS 的 .app 布局也算已安装", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-kicad-"));
    const app = join(dataDir, "runtime", "kicad");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "MacOS", "kicad-cli"), "");
    delete process.env.KENFUTWORK_KICAD_APP;
    expect(new KicadWorker(dataDir).kicadInstalled()).toBe(true);
  });
});
