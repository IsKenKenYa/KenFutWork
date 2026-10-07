import { describe, expect, it } from "vitest";

import { isValidBuiltinModelId } from "./builtin-models.js";
import {
  BUILTIN_VOICE_MODELS,
  builtinModelSize,
  builtinModelSizeBytes,
  findBuiltinModel,
} from "./catalog.js";

describe("内置模型目录表", () => {
  it("id 唯一且能安全当目录名用", () => {
    const ids = BUILTIN_VOICE_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isValidBuiltinModelId(id)).toBe(true);
    }
  });

  it("每个模型都有许可声明与可计算体积（界面要显示，规划 §10 风险 7）", () => {
    for (const model of BUILTIN_VOICE_MODELS) {
      expect(model.license.length).toBeGreaterThan(0);
      expect(builtinModelSizeBytes(model)).toBeGreaterThan(0);
      expect(model.files.length).toBeGreaterThan(0);
    }
  });

  it("layout 里每个路径都能在 files 找到（防两处漂移）", () => {
    for (const model of BUILTIN_VOICE_MODELS) {
      const paths = model.files.map((file) => file.path);
      const layoutPaths = Object.values(model.layout).filter(
        (value): value is string => typeof value === "string",
      );
      expect(layoutPaths.length).toBeGreaterThan(0);
      for (const path of layoutPaths) {
        if (path === "") continue;
        // 既可以是清单里的某个文件，也可以是一个**目录**（如 kokoro 的 espeak-ng-data：
        // layout 要的是目录本身，清单里列的是它下面的每个文件）
        const isFile = paths.includes(path);
        const isDirectory = paths.some((candidate) =>
          candidate.startsWith(`${path}/`),
        );
        expect(
          isFile || isDirectory,
          `${model.id} 的 layout 路径 ${path} 既不在 files 里，也不是任何文件的目录前缀`,
        ).toBe(true);
      }
    }
  });

  it("校验和钉死：64 位十六进制，且与体积一起构成下载门禁", () => {
    for (const model of BUILTIN_VOICE_MODELS) {
      for (const file of model.files) {
        expect(file.sha256, `${model.id}/${file.path}`).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(file.sizeBytes).toBeGreaterThan(0);
        expect(file.url.startsWith("https://")).toBe(true);
        // 相对路径不得越目录（下载落盘直接拼这个路径）
        expect(file.path.includes("..")).toBe(false);
        expect(file.path.startsWith("/")).toBe(false);
      }
    }
  });

  it("说段（Kokoro）清单完整：300+ 文件、300MB+ 体积（防生成物被截断）", () => {
    const kokoro = findBuiltinModel("kokoro-multi-lang");
    expect(kokoro?.segment).toBe("speak");
    // 375 个文件（2026-09-27 取回）；上限放宽一点，只防「被截断/被清空」
    expect(kokoro?.files.length ?? 0).toBeGreaterThan(350);
    expect(builtinModelSizeBytes(kokoro as never)).toBeGreaterThan(
      350 * 1024 * 1024,
    );
    // 清单里必须含 layout 用到的每一类文件
    const paths = new Set((kokoro?.files ?? []).map((file) => file.path));
    for (const required of [
      "model.onnx",
      "voices.bin",
      "tokens.txt",
      "lexicon-zh.txt",
    ]) {
      expect(paths.has(required), `清单缺 ${required}`).toBe(true);
    }
    expect([...paths].some((path) => path.startsWith("espeak-ng-data/"))).toBe(
      true,
    );
  });

  it("听段确实有内置模型（默认档要能落地）", () => {
    const listen = BUILTIN_VOICE_MODELS.filter(
      (model) => model.segment === "listen",
    );
    expect(listen.length).toBeGreaterThan(0);
  });

  it("查表：认出的返回本体，认不出的整体为 undefined", () => {
    expect(findBuiltinModel("sensevoice-small-int8")?.segment).toBe("listen");
    expect(findBuiltinModel("ghost")).toBeUndefined();
    expect(builtinModelSize("sensevoice-small-int8")).toBeGreaterThan(
      200 * 1024 * 1024,
    );
    expect(builtinModelSize("ghost")).toBe(0);
  });
});
