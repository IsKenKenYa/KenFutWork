import { expect, it } from "vitest";
import {
  jsonbSafeStringify,
  sanitizeNulDeep,
  stripNulCharacters,
} from "./text-sanitize.js";

const NUL = "\u0000";

it("stripNulCharacters：剥掉全部 U+0000，不含 NUL 时原样返回", () => {
  expect(stripNulCharacters(`a${NUL}b${NUL}c`)).toBe("abc");
  // UTF-16LE 输出被按 UTF-8 解码的典型形态：每个 ASCII 字符后跟一个 NUL
  expect(stripNulCharacters(`w${NUL}s${NUL}l${NUL}`)).toBe("wsl");
  const clean = "没有 NUL";
  expect(stripNulCharacters(clean)).toBe(clean);
  // 返回同一引用（不产生无谓新串）
  expect(stripNulCharacters(clean)).toBe(clean);
});

it("sanitizeNulDeep：对象/数组/嵌套都剥 NUL，且不改动入参", () => {
  const input = {
    output: `x${NUL}y`,
    nested: { list: [`a${NUL}`, 1, null, true] },
    keep: undefined,
  };
  const out = sanitizeNulDeep(input) as typeof input;
  expect(out.output).toBe("xy");
  expect(out.nested.list).toEqual(["a", 1, null, true]);
  expect(out.keep).toBeUndefined();
  // 入参未被改动
  expect(input.output).toBe(`x${NUL}y`);
});

it("sanitizeNulDeep：共享引用（DAG）也要拿到清洗后的副本", () => {
  const shared = { text: `s${NUL}hared` };
  const out = sanitizeNulDeep({ a: shared, b: shared }) as {
    a: { text: string };
    b: { text: string };
  };
  expect(out.a.text).toBe("shared");
  expect(out.b.text).toBe("shared");
});

it("sanitizeNulDeep：循环引用不死循环（交给 JSON.stringify 抛同样的错）", () => {
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic.self = cyclic;
  expect(() => JSON.stringify(sanitizeNulDeep(cyclic))).toThrow(/circular/i);
});

it("jsonbSafeStringify：NUL 不再变成字面量 \\u0000（Postgres 拒绝该转义）", () => {
  const text = `命令输出：${NUL}${NUL}proof${NUL}`;
  const json = jsonbSafeStringify({ output: text, display: { output: text } });
  expect(json).toBeTypeOf("string");
  expect(json).not.toContain("\\u0000");
  expect(json).not.toContain(NUL);
  expect(JSON.parse(String(json))).toEqual({
    output: "命令输出：proof",
    display: { output: "命令输出：proof" },
  });
  // 对照：未清洗时 JSON.stringify 会产出字面量 \u0000（Postgres jsonb 会拒绝）
  expect(JSON.stringify({ output: text })).toContain("\\u0000");
});

it("jsonbSafeStringify：普通值语义与 JSON.stringify 一致", () => {
  expect(jsonbSafeStringify({ a: 1, b: [true, null] })).toBe(
    JSON.stringify({ a: 1, b: [true, null] }),
  );
  expect(jsonbSafeStringify(undefined)).toBeUndefined();
  expect(jsonbSafeStringify("x")).toBe('"x"');
});
