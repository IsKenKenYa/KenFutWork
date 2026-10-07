import { expect, test } from "vitest";
import { prepareLinuxSandboxArgv } from "./linux-launch.js";

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
