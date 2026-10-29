import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KicadWorker, pickKicadInstall, remapContainerPaths } from "./worker.js";

/**
 * KiCad 安装位置只有两个来源：显式 `KENFUTWORK_KICAD_APP`，或实例数据目录里的便携解包目录。
 * 这条锁定「没装 KiCad 时不误报可用、装了以后能被找到」。
 */

const previous = process.env.KENFUTWORK_KICAD_APP;
const previousDocker = process.env.KENFUTWORK_KICAD_DOCKER;
afterEach(() => {
  if (previous === undefined) delete process.env.KENFUTWORK_KICAD_APP;
  else process.env.KENFUTWORK_KICAD_APP = previous;
  if (previousDocker === undefined) delete process.env.KENFUTWORK_KICAD_DOCKER;
  else process.env.KENFUTWORK_KICAD_DOCKER = previousDocker;
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

  it("Windows 默认安装：按版本号数字序挑最新的带 kicad-cli 的目录", () => {
    const root = mkdtempSync(join(tmpdir(), "kfw-kicad-pf-"));
    expect(pickKicadInstall([join(root, "missing")])).toBeNull();
    for (const version of ["9.0", "10.0", "8.0"]) {
      mkdirSync(join(root, version, "bin"), { recursive: true });
    }
    // 只有 10.0 与 8.0 带 kicad-cli：9.0 结构不全，应当跳过。
    writeFileSync(join(root, "10.0", "bin", "kicad-cli.exe"), "");
    writeFileSync(join(root, "8.0", "bin", "kicad-cli.exe"), "");
    expect(pickKicadInstall([root])).toBe(join(root, "10.0"));
  });

  it("容器模式：镜像即安装，不需要宿主任何 KiCad 文件", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-kicad-"));
    process.env.KENFUTWORK_KICAD_DOCKER = "kicad/kicad:10.0";
    const worker = new KicadWorker(dataDir);
    expect(worker.dockerImage()).toBe("kicad/kicad:10.0");
    expect(worker.kicadInstalled()).toBe(true);
    expect(worker.kicadAppDir()).toBe("kicad/kicad:10.0");
  });

  it("容器结果里的 /ws、/data 映射回宿主路径（含嵌套结构）", () => {
    const input = {
      path: "/ws/kicad/out/board.gbr",
      nested: ["/data/store/board", { note: "kept", size: 3 }],
    };
    expect(
      remapContainerPaths(input, [
        ["/ws", "D:\ws"],
        ["/data", "D:\data"],
      ]),
    ).toEqual({
      path: "D:\ws/kicad/out/board.gbr",
      nested: ["D:\data/store/board", { note: "kept", size: 3 }],
    });
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
