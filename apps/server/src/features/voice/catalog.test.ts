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
      const paths = new Set(model.files.map((file) => file.path));
      const layoutPaths = Object.values(model.layout).filter(
        (value): value is string => typeof value === "string",
      );
      expect(layoutPaths.length).toBeGreaterThan(0);
      for (const path of layoutPaths) {
        if (path === "") continue;
        expect(
          paths,
          `${model.id} 的 layout 路径 ${path} 不在 files 里`,
        ).toContain(path);
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
