import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c as createTar } from "tar";
import { describe, expect, it } from "vitest";

import { createSagCliInstaller } from "./cli-install.js";
import {
  SAG_CLI_INTEGRITY,
  SAG_CLI_TARBALL,
  SAG_CLI_VERSION,
} from "./sag-cli-contract.js";

const binaryName = "sag.exe";

/** 造一个 npm 形状的 tarball（`package/native/<target>/sag.exe` + LICENSE）。 */
async function buildTarball(
  payload: Buffer,
): Promise<{ tarball: Buffer; sha512: string }> {
  const work = await mkdtemp(join(tmpdir(), "kfw-sag-tar-"));
  const dir = join(work, "package", "native", "win32-x64");
  await mkdir(dir, { recursive: true });
  await writeFile(join(work, "package", "LICENSE"), "MIT\n");
  await writeFile(join(dir, binaryName), payload);
  const target = join(work, "sag.tgz");
  await createTar({ gzip: true, file: target, cwd: work, portable: true }, [
    "package",
  ]);
  const tarball = await readFile(target);
  return {
    tarball,
    sha512: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  };
}

function fakeFetch(tarball: Buffer) {
  return (async () =>
    new Response(new Uint8Array(tarball), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })) as typeof fetch;
}

describe("SAG CLI 三级探测（KB-5）", () => {
  it("系统已装优先复用，绝不下载", async () => {
    let fetched = 0;
    const installer = createSagCliInstaller({
      dataDir: await mkdtemp(join(tmpdir(), "kfw-sag-")),
      platform: "win32",
      arch: "x64",
      probe: async (binary) => binary === "sag",
      fetchFn: (async () => {
        fetched += 1;
        return new Response("");
      }) as typeof fetch,
    });
    expect(await installer.inspect()).toEqual({
      kind: "system",
      binary: "sag",
    });
    expect(await installer.resolve()).toEqual({
      kind: "system",
      binary: "sag",
    });
    expect(fetched).toBe(0);
  });

  it("平台无原生二进制：fail loud，不探测也不下载", async () => {
    let probed = 0;
    const installer = createSagCliInstaller({
      dataDir: await mkdtemp(join(tmpdir(), "kfw-sag-")),
      platform: "linux",
      arch: "x64",
      probe: async () => {
        probed += 1;
        return false;
      },
    });
    const result = await installer.inspect();
    expect(result.kind).toBe("unsupported_platform");
    expect(await installer.resolve()).toEqual(result);
    expect(probed).toBe(0);
  });

  it("未装则按需下载钉版本：校验和通过后原子落位（二进制 + 许可 + 标记）", async () => {
    const payload = Buffer.from("fake-binary");
    const built = await buildTarball(payload);
    const dataDir = await mkdtemp(join(tmpdir(), "kfw-sag-"));
    const managedDir = join(
      dataDir,
      "knowledge",
      "sag",
      `${SAG_CLI_VERSION}-win32-x64`,
    );
    const installer = createSagCliInstaller({
      dataDir,
      platform: "win32",
      arch: "x64",
      probe: async (binary) => binary === join(managedDir, binaryName),
      fetchFn: fakeFetch(built.tarball),
      tarballUrl: SAG_CLI_TARBALL,
      integrity: built.sha512,
    });
    const result = await installer.resolve();
    expect(result).toEqual({
      kind: "managed",
      binary: join(managedDir, binaryName),
    });
    expect(await readFile(join(managedDir, binaryName))).toEqual(payload);
    expect(await readFile(join(managedDir, "LICENSE"), "utf8")).toBe("MIT\n");
    const marker = JSON.parse(
      await readFile(join(managedDir, "install.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({
      version: SAG_CLI_VERSION,
      target: "win32-x64",
      integrity: built.sha512,
    });
    // 再次 resolve 走缓存，不再下载
    expect(await installer.resolve()).toEqual(result);
  });

  it("校验和不匹配：显式 missing、不留半截目录", async () => {
    const built = await buildTarball(Buffer.from("tampered"));
    const dataDir = await mkdtemp(join(tmpdir(), "kfw-sag-"));
    const installer = createSagCliInstaller({
      dataDir,
      platform: "win32",
      arch: "x64",
      probe: async () => false,
      fetchFn: fakeFetch(built.tarball),
      integrity: "sha512-AAAA",
    });
    const result = await installer.resolve();
    expect(result.kind).toBe("missing");
    expect(result.kind === "missing" ? result.reason : "").toContain(
      "校验和不匹配",
    );
    const sagRoot = join(dataDir, "knowledge", "sag");
    await expect(readFile(sagRoot)).rejects.toThrow();
    void sagRoot;
  });

  it("已落位自带 CLI：直接复用，不再下载", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kfw-sag-"));
    const managedDir = join(
      dataDir,
      "knowledge",
      "sag",
      `${SAG_CLI_VERSION}-win32-x64`,
    );
    await mkdir(managedDir, { recursive: true });
    await writeFile(join(managedDir, binaryName), "bin");
    let fetched = 0;
    const installer = createSagCliInstaller({
      dataDir,
      platform: "win32",
      arch: "x64",
      probe: async (binary) => binary === join(managedDir, binaryName),
      fetchFn: (async () => {
        fetched += 1;
        return new Response("");
      }) as typeof fetch,
    });
    const result = await installer.inspect();
    expect(result).toEqual({
      kind: "managed",
      binary: join(managedDir, binaryName),
    });
    expect(fetched).toBe(0);
  });

  it("下载失败（网络/HTTP）显式 missing 且带离线安装指引", async () => {
    const installer = createSagCliInstaller({
      dataDir: await mkdtemp(join(tmpdir(), "kfw-sag-")),
      platform: "win32",
      arch: "x64",
      probe: async () => false,
      fetchFn: (async () => new Response("", { status: 503 })) as typeof fetch,
    });
    const result = await installer.resolve();
    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      expect(result.reason).toContain("HTTP 503");
      expect(result.guidance).toContain("npm install -g @zleap-ai/sag");
    }
  });
});
