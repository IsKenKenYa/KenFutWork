import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { contributionFingerprint } from "./contribution-fingerprint.js";

it("嵌套字段顺序和缺省undefined不改变摘要，也不修改原配置", () => {
  const nested = { z: 2, a: 1 };
  const first = {
    env: { TOKEN: "private-test-value", ABSENT: undefined },
    args: ["server.mjs", nested],
    command: "node",
  };
  const second = {
    command: "node",
    args: ["server.mjs", { a: 1, z: 2 }],
    env: { TOKEN: "private-test-value" },
  };
  const expected = createHash("sha256")
    .update(
      '{"args":["server.mjs",{"a":1,"z":2}],"command":"node","env":{"TOKEN":"private-test-value"}}',
    )
    .digest("hex");
  expect(contributionFingerprint(first)).toBe(expected);
  expect(contributionFingerprint(second)).toBe(expected);
  expect(Object.keys(first.env)).toEqual(["TOKEN", "ABSENT"]);
  expect(Object.keys(nested)).toEqual(["z", "a"]);
});

it("数组顺序、undefined位置以及null/false/零保留区别", () => {
  expect(contributionFingerprint({ args: ["--mode", "read"] })).not.toBe(
    contributionFingerprint({ args: ["read", "--mode"] }),
  );
  const expected = createHash("sha256")
    .update('{"args":[null,false,0,""]}')
    .digest("hex");
  expect(contributionFingerprint({ args: [undefined, false, 0, ""] })).toBe(
    expected,
  );
  expect(contributionFingerprint({ args: [undefined, false, 0, ""] })).not.toBe(
    contributionFingerprint({ args: [false, 0, ""] }),
  );
  expect(contributionFingerprint({ option: null })).not.toBe(
    contributionFingerprint({ option: undefined }),
  );
});

it("凭据影响能力身份，但结果仅返回固定摘要，不携带原字段", () => {
  const first = contributionFingerprint({
    env: { API_KEY: "private-test-value" },
  });
  const changed = contributionFingerprint({
    env: { API_KEY: "rotated-test-value" },
  });
  expect(first).not.toBe(changed);
  expect(first).toMatch(/^[a-f0-9]{64}$/u);
  expect(first).not.toContain("API_KEY");
  expect(first).not.toContain("private-test-value");
});
