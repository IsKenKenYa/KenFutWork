import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDistManifest,
  classifyAuthenticode,
  classifyCodesignDisplay,
  findMachOFiles,
  isMachOHeader,
  verifyMachOFiles,
} from "./dist-manifest.mjs";

const MACHO_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
const NOT_MACHO = Buffer.from("plain text");

test("isMachOHeader 认 64 位与 fat 魔数，拒绝文本与短文件头", () => {
  assert.equal(isMachOHeader(MACHO_64), true);
  assert.equal(
    isMachOHeader(Buffer.from([0xca, 0xfe, 0xba, 0xbe])),
    true,
    "fat binary（pg/bin 里 initdb 等就是双架构）必须认",
  );
  assert.equal(isMachOHeader(NOT_MACHO), false);
  assert.equal(isMachOHeader(Buffer.from([0xcf, 0xfa])), false);
});

test("findMachOFiles 递归找 Mach-O，软链按真实路径去重", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kfw-macho-"));
  try {
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "bin.txt"), NOT_MACHO);
    writeFileSync(join(dir, "app"), MACHO_64);
    writeFileSync(join(dir, "lib", "thing.dylib"), MACHO_64);
    // pg/lib 靠 pg-symlinks.json 建软链存活，计数不能被同一真身重复吃两次
    symlinkSync(
      join(dir, "lib", "thing.dylib"),
      join(dir, "lib", "thing.linking.dylib"),
    );
    const found = findMachOFiles(dir).map((file) => file.slice(dir.length + 1));
    assert.deepEqual(
      found.sort(),
      ["app", join("lib", "thing.dylib")].sort(),
      "应只含两个真实 Mach-O：文本文件不算、软链指向的真身不重复计",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyCodesignDisplay 把签名状态如实归类，不给乐观默认值", () => {
  assert.equal(
    classifyCodesignDisplay("Code Directory size=1234\nSignature=adhoc"),
    "adhoc",
  );
  assert.equal(
    classifyCodesignDisplay("Authority=Developer ID Application: Foo (TEAMID)"),
    "developer-id",
  );
  assert.equal(
    classifyCodesignDisplay("code object is not signed at all"),
    "unsigned",
  );
  assert.equal(
    classifyCodesignDisplay("Executable=/tmp/weird\r\nSOMETHING=else"),
    "unknown",
    "认不出的输出必须落 unknown，不许蒙成已签名",
  );
});

test("classifyAuthenticode 按 PowerShell 的 Status 归类", () => {
  assert.equal(classifyAuthenticode("NotSigned"), "unsigned");
  assert.equal(classifyAuthenticode("Valid"), "authenticode-valid");
  assert.equal(
    classifyAuthenticode("HashMismatch"),
    "authenticode-hashmismatch",
  );
  assert.equal(classifyAuthenticode("   "), "unknown");
});

test("verifyMachOFiles 用外部 codesign 协议夹具，只报失败计数", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kfw-codesign-"));
  try {
    const fake = join(dir, "codesign");
    // 夹具协议：路径里含 "bad" 即验签失败——用来证明计数真的来自 codesign 的退出码
    writeFileSync(
      fake,
      '#!/bin/sh\nfor a in "$@"; do case "$a" in *bad*) exit 1;; esac; done\nexit 0\n',
    );
    chmodSync(fake, 0o755);
    if (
      spawnSync(fake, ["--verify", "/tmp/x"], { shell: false }).status === null
    ) {
      console.log("· 跳过：本机不能直接 exec sh 夹具");
      return;
    }
    const files = [
      join(dir, "good.node"),
      join(dir, "bad.node"),
      join(dir, "ok2"),
    ];
    const result = verifyMachOFiles(files, fake);
    assert.equal(result.total, 3);
    assert.equal(result.failedTotal, 1);
    assert.deepEqual(result.failedSample, [join(dir, "bad.node")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDistManifest 的产物只收真实存在的文件，并带 sha256 与字节数", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kfw-manifest-"));
  try {
    const real = join(dir, "KenFutWork_0.1.4_arm64.dmg");
    writeFileSync(real, Buffer.from("安装包字节"));
    const manifest = buildDistManifest({
      root: dir,
      version: "0.1.4",
      platform: "darwin",
      commit: "abc123",
      ref: "main",
      artifacts: [real, join(dir, "不存在的.zip")],
      signing: { status: "adhoc", provider: "adhoc" },
    });
    assert.equal(manifest.artifacts.length, 1, "不存在的产物不许进清单");
    assert.equal(manifest.artifacts[0].file, "KenFutWork_0.1.4_arm64.dmg");
    assert.equal(
      manifest.artifacts[0].sha256,
      createHash("sha256").update(readFileSync(real)).digest("hex"),
    );
    assert.equal(
      manifest.artifacts[0].size,
      15,
      "「安装包字节」UTF-8 下 15 字节",
    );
    assert.equal(manifest.signing.status, "adhoc");
    assert.equal(
      manifest.runtimeVersions,
      null,
      "无 runtime-lock 时如实留空，不编版本",
    );
    assert.equal(manifest.macos, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDistManifest 默认值一律是「不知道」，不是看起来像签好了", () => {
  const manifest = buildDistManifest({ version: null, platform: null });
  assert.equal(manifest.signing.status, "unknown");
  assert.equal(manifest.signing.provider, "none");
  assert.equal(manifest.version, null);
  assert.equal(manifest.build.rustc, null);
});
