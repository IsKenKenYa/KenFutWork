import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { prepareLinuxSandboxArgv } from "./linux-launch.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const flags =
  "--new-session --die-with-parent --unshare-net --unshare-pid --unshare-user --dev /dev --proc /proc";
const command = '\'printf "--new-session $HOME; %s" "a b"\'';
const tail = ` -- /bin/sh -c ${command}`;

test("只移除 leading bwrap session 标志，用户命令与全部隔离参数保持原字节", () => {
  const source = `bwrap ${flags}${tail}`;
  expect(prepareLinuxSandboxArgv(["/bin/sh", "-c", source], true)).toEqual([
    "/bin/sh",
    "-c",
    `bwrap ${flags.replace("--new-session ", "")}${tail}`,
  ]);
});

test("SRT 长 mount profile 的 fd loader 保留，隔离参数依然在 argv 校验", () => {
  const source = `/bin/sh -c 'exec 9<"$1" && shift && exec "$@"' srt-args /proc/123/fd/4 bwrap ${flags} --args 9${tail}`;
  expect(prepareLinuxSandboxArgv(["/bin/sh", "-c", source], true)[2]).toBe(
    source.replace("bwrap --new-session ", "bwrap "),
  );
});

test.each([
  `bwrap ${flags.replace("--unshare-pid ", "")}${tail}`,
  `bwrap ${flags.replace("--unshare-user ", "")}${tail}`,
  `bwrap ${flags.replace("--proc /proc", "--bind /proc /proc")}${tail}`,
  `bwrap ${flags}${tail}; touch /escape`,
  `bwrap ${flags}${tail}\ntouch /escape`,
  `bwrap ${flags}${tail} # ignored`,
  `bwrap ${flags} -- /bin/sh -c "$(touch /escape)"`,
  `bwrap ${flags} --new-session${tail}`,
  `/bin/sh -c 'exec 9<"$1" && shift && exec "$@"' srt-args /tmp/other bwrap ${flags} --args 9${tail}`,
])("未知或弱 namespace wrapper fail closed: %s", (source) => {
  expect(() =>
    prepareLinuxSandboxArgv(["/bin/sh", "-c", source], true),
  ).toThrow("SRT Linux wrapper 结构改变");
});

test("强 denyRead tmpfs 后重放 SRT 精确内部 socket，pipe 保留 --new-session", () => {
  const bind = "--bind /tmp/srt-obs-abc/s123.sock /tmp/srt-obs-abc/s123.sock";
  const source = `bwrap --new-session --die-with-parent ${bind} --setenv SRT_OBSERVE_SOCK /tmp/srt-obs-abc/s123.sock --tmpfs /tmp --dev /dev --unshare-pid --unshare-user --proc /proc${tail}`;
  expect(prepareLinuxSandboxArgv(["/bin/sh", "-c", source], false)[2]).toBe(
    source.replace("--dev /dev", `${bind} --dev /dev`),
  );
});

test("私有 metadata 的 tmpfs 遮蔽层在所有 mount 后 remount readonly", () => {
  const source = `bwrap ${flags.replace("--dev /dev ", "--tmpfs /task/capture --dev /dev ")}${tail}`;
  expect(
    prepareLinuxSandboxArgv(
      ["/bin/sh", "-c", source],
      false,
      "/task/capture",
    )[2],
  ).toBe(
    source.replace("--dev /dev", "--remount-ro '/task/capture' --dev /dev"),
  );
});

test.each([false, true])(
  "只读请求在 mounts/socket 后收紧遮蔽层并保留 Task 临时目录 RW bind，PTY=%s",
  (pty) => {
    const socket =
      "--bind /tmp/srt-obs-abc/s123.sock /tmp/srt-obs-abc/s123.sock";
    const mounts =
      "--ro-bind / / --tmpfs /tmp --bind /tmp/kfw-task-process-unit /tmp/kfw-task-process-unit --ro-bind /task /task --tmpfs /home --tmpfs /task/capture --tmpfs /tmp";
    const source = `bwrap --new-session --die-with-parent ${socket} ${mounts} --dev /dev --unshare-pid --unshare-user --proc /proc${tail}`;
    const remounts =
      "--remount-ro '/tmp' --remount-ro '/home' --remount-ro '/task/capture'";
    const expected = source.replace(
      "--dev /dev",
      `${socket} ${remounts} --dev /dev`,
    );
    expect(
      prepareLinuxSandboxArgv(
        ["/bin/sh", "-c", source],
        pty,
        "/task/capture",
        true,
      )[2],
    ).toBe(pty ? expected.replace("bwrap --new-session ", "bwrap ") : expected);
  },
);

test("默认写策略只收紧 private mask，不改变其他隔离 tmpfs 与 Task RW bind", () => {
  const source = `bwrap ${flags.replace("--dev /dev ", "--tmpfs /tmp --bind /tmp/kfw-task-process-unit /tmp/kfw-task-process-unit --ro-bind /task /task --tmpfs /task/capture --dev /dev ")}${tail}`;
  expect(
    prepareLinuxSandboxArgv(
      ["/bin/sh", "-c", source],
      false,
      "/task/capture",
    )[2],
  ).toBe(
    source.replace("--dev /dev", "--remount-ro '/task/capture' --dev /dev"),
  );
});

test("只读 fd mounts 收紧遮蔽层，保留 loader 与文件内 Task 临时目录 RW bind", () => {
  const mounts =
    "--ro-bind\0/\0/\0--tmpfs\0/tmp\0--bind\0/tmp/kfw-task-process-unit\0/tmp/kfw-task-process-unit\0--ro-bind\0/task\0/task\0--tmpfs\0/home\0";
  vi.mocked(readFileSync).mockReturnValueOnce(Buffer.from(mounts));
  const source = `/bin/sh -c 'exec 9<"$1" && shift && exec "$@"' srt-args /proc/123/fd/4 bwrap --new-session --die-with-parent --args 9 --dev /dev --unshare-pid --unshare-user --proc /proc${tail}`;
  expect(
    prepareLinuxSandboxArgv(
      ["/bin/sh", "-c", source],
      false,
      undefined,
      true,
    )[2],
  ).toBe(
    source.replace(
      "--dev /dev",
      "--remount-ro '/tmp' --remount-ro '/home' --dev /dev",
    ),
  );
  expect(readFileSync).toHaveBeenCalledWith("/proc/123/fd/4");
});

test("只读 wrapper 不把环境变量值识别成 tmpfs 挂载", () => {
  const source = `bwrap --new-session --die-with-parent --setenv VALUE --tmpfs --tmpfs /tmp --dev /dev --unshare-pid --unshare-user --proc /proc${tail}`;
  expect(
    prepareLinuxSandboxArgv(
      ["/bin/sh", "-c", source],
      false,
      undefined,
      true,
    )[2],
  ).toBe(source.replace("--dev /dev", "--remount-ro '/tmp' --dev /dev"));
});

test.each(["relative", ""])(
  "只读请求拒绝 direct/fd wrapper 中无效的 tmpfs 目标：%s",
  (target) => {
    const direct = `bwrap ${flags.replace("--dev /dev ", `--tmpfs ${target} --dev /dev `)}${tail}`;
    expect(() =>
      prepareLinuxSandboxArgv(
        ["/bin/sh", "-c", direct],
        false,
        undefined,
        true,
      ),
    ).toThrow("SRT Linux wrapper 结构改变");
    vi.mocked(readFileSync).mockReturnValueOnce(
      Buffer.from(["--tmpfs", target].join("\0")),
    );
    const indirect = `/bin/sh -c 'exec 9<"$1" && shift && exec "$@"' srt-args /proc/123/fd/4 bwrap ${flags} --args 9${tail}`;
    expect(() =>
      prepareLinuxSandboxArgv(
        ["/bin/sh", "-c", indirect],
        false,
        undefined,
        true,
      ),
    ).toThrow("SRT Linux wrapper 结构改变");
  },
);
