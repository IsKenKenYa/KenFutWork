import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { unixPolicy, unixRuntimeReadRoots } from "./policy.js";

describe("沙箱运行时读取基线", () => {
  it("darwin 授予第三方工具链前缀（git 装在 /opt/homebrew，不在 /usr 之下）", () => {
    const roots = unixRuntimeReadRoots([], "darwin");
    // 缺这一条时，沙箱内 `env git …` 报 Operation not permitted：影子检查点恒空。
    expect(roots).toContain("/opt/homebrew");
    expect(roots).toContain("/usr");
    expect(roots).toContain("/System");
  });

  it("非 darwin 不引入 macOS 专有前缀", () => {
    const roots = unixRuntimeReadRoots([], "linux");
    expect(roots).not.toContain("/opt/homebrew");
    expect(roots).not.toContain("/[v]ar");
    expect(roots).not.toContain("/private/[v]ar");
    expect(roots).not.toContain("/var/[d]b");
    expect(roots).not.toContain("/var/db/xcode_select_link");
  });

  it("darwin 缺失开发工具选择器的查询仅开放父目录自身", () => {
    const roots = unixRuntimeReadRoots([], "darwin");
    expect(roots).toContain("/[v]ar");
    expect(roots).toContain("/private/[v]ar");
    expect(roots).toContain("/var/[d]b");
    expect(roots).toContain("/private/var/[d]b");
    expect(roots).toContain("/var/db/xcode_select_link");
    expect(roots).toContain("/private/var/db/xcode_select_link");
    expect(roots).not.toContain("/private/var");
    expect(roots).not.toContain("/var/select/*");
    expect(roots).not.toContain("/private/var/select/*");
    expect(roots).not.toContain("/var/db");
    expect(roots).not.toContain("/private/var/db");
  });

  it("基线只覆盖软件目录，不放开用户数据目录", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(unixRuntimeReadRoots([], platform)).not.toContain("/Users");
      expect(unixRuntimeReadRoots([], platform)).not.toContain("/home");
      expect(unixRuntimeReadRoots([], platform)).not.toContain("/var");
    }
  });

  it("调用方追加的运行时根参与去重", () => {
    const roots = unixRuntimeReadRoots(["/opt/custom/runtime", "/usr"]);
    expect(roots).toContain("/opt/custom/runtime");
    expect(roots.filter((path) => path === "/usr")).toHaveLength(1);
  });

  it.skipIf(process.platform !== "darwin")(
    "系统选择的开发工具仅授予自身资源，不授予安装卷和写入权限",
    async () => {
      const { stdout } = await promisify(execFile)(
        "/usr/bin/xcode-select",
        ["--print-path"],
        { env: {} },
      );
      const developer = await realpath(stdout.trim());
      const directory = await mkdtemp(join(tmpdir(), "kfw-developer-policy-"));
      const root = join(directory, "project");
      const temporaryDirectory = join(directory, "temporary");
      const privateDirectory = join(directory, "private");
      try {
        await Promise.all([
          mkdir(root),
          mkdir(temporaryDirectory),
          mkdir(privateDirectory),
        ]);
        const policy = await unixPolicy({
          scope: {
            instanceId: "instance",
            projectId: "project",
            taskId: "developer-policy",
            generation: 1,
            rootDirectory: root,
            additionalDirectories: [],
            sandboxMode: "read-only",
          },
          temporaryDirectory,
          privateDirectory,
          network: { allowedDomains: [], deniedDomains: [] },
        });
        expect(
          policy.filesystem.allowRead?.some(
            (allowed) =>
              developer === allowed || developer.startsWith(`${allowed}/`),
          ),
        ).toBe(true);
        if (developer.endsWith(".app/Contents/Developer")) {
          expect(policy.filesystem.allowRead).toContain(dirname(developer));
          expect(policy.filesystem.allowRead).not.toContain(
            dirname(dirname(developer)),
          );
        } else {
          expect(policy.filesystem.allowRead).not.toContain(dirname(developer));
        }
        expect(policy.filesystem.allowRead).not.toContain("/Volumes");
        expect(policy.filesystem.allowRead).not.toContain("/");
        expect(policy.filesystem.allowWrite).not.toContain(developer);
        expect(policy.filesystem.allowWrite).not.toContain(dirname(developer));
        expect(policy.filesystem.allowWrite).not.toContain(root);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
