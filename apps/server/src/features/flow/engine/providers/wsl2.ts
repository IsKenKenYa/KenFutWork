import type { FlowEnginePath } from "@kenfutwork/shared";

import { decodeCommandText, type RunCommand } from "../exec.js";

/**
 * Provider A：WSL2 承载（Windows 专属，《flow 集成方案》§3.5.1）。
 *
 * 只做**探测**（不安装、不下载镜像）：够不够资格跑引擎看三件事——
 * ① 平台是 Windows 且版本 ≥ 19041（WSL2 的硬前提，Win10 1809 及更早没有完整内核）；
 * ② `wsl.exe` 存在且 `--status` 能答（没装/没启用会非零退出）；
 * ③ `-l -v` 里**至少有一个 VERSION 2 的发行版**（WSL1 没有完整内核与 systemd，不合适）。
 *
 * 输出解析的两个坑：`wsl.exe` 可能按 UTF-16LE 输出（`decodeCommandText` 处理）；
 * 输出是**本地化**的（中/英），故不匹配「默认版本」这类文案，只按结构解析列表。
 */
export async function probeWsl2Path(deps: {
  platform: NodeJS.Platform;
  /** `os.release()`（如 "10.0.26200"）。 */
  release: string;
  run: RunCommand;
}): Promise<FlowEnginePath> {
  const base = { id: "wsl2" as const, label: "WSL2" };

  if (deps.platform !== "win32") {
    return {
      ...base,
      available: false,
      reason:
        "WSL2 仅 Windows 可用；本平台请看「本机容器」或「指向自管地址」。",
    };
  }

  const build = Number.parseInt(deps.release.split(".")[2] ?? "", 10);
  if (!Number.isFinite(build) || build < 19041) {
    return {
      ...base,
      available: false,
      reason: `Windows 版本过低（需 19041+，当前内核 ${deps.release}）：WSL1 或旧版没有完整内核与 systemd，不能承载引擎。`,
    };
  }

  const status = await deps.run("wsl.exe", ["--status"]);
  if (status.code !== 0) {
    const hint = decodeCommandText(status.stderr).split("\n")[0]?.trim();
    return {
      ...base,
      available: false,
      reason:
        "WSL 未安装或未启用。管理员执行 `wsl --install` 后重试。" +
        (hint ? `（系统提示：${hint.slice(0, 120)}）` : ""),
    };
  }

  const list = await deps.run("wsl.exe", ["-l", "-v"]);
  if (list.code !== 0) {
    const hint = decodeCommandText(list.stderr).split("\n")[0]?.trim();
    return {
      ...base,
      available: false,
      reason:
        "`wsl -l -v` 取不到发行版列表（WSL 处于未初始化状态）。" +
        (hint ? `（系统提示：${hint.slice(0, 120)}）` : ""),
    };
  }

  const distros = parseWslDistros(decodeCommandText(list.stdout));
  // 排除 Docker Desktop 的内部发行版：它们由 Docker 自己管理（不是用户可用的通用发行版），
  // 也不是「内核内跑开源容器引擎」这条路径的载体——命中它们会让探测报出虚假的可用。
  const userDistros = distros.filter(
    (distro) => !isDockerDesktopDistro(distro.name),
  );
  if (userDistros.length === 0 && distros.length > 0) {
    return {
      ...base,
      available: false,
      reason:
        `只找到 Docker Desktop 的内部发行版（${distros.map((d) => d.name).join("、")}）：` +
        "它们不作为引擎承载。请 `wsl --install -d <发行版名>` 装一个通用发行版，或直接用「本机容器」。",
    };
  }

  const wsl2 = userDistros.find((distro) => distro.version === 2);
  if (wsl2) {
    return {
      ...base,
      available: true,
      detail: `发行版 ${wsl2.name}（WSL2，${wsl2.state}）`,
    };
  }
  if (userDistros.length > 0) {
    return {
      ...base,
      available: false,
      reason:
        `已有发行版（${userDistros.map((d) => d.name).join("、")}）但都是 WSL1：` +
        "请 `wsl --set-default-version 2` 后安装 WSL2 发行版（WSL1 无完整内核）。",
    };
  }
  return {
    ...base,
    available: false,
    reason:
      "WSL2 可用但还没有发行版：执行 `wsl --install -d <发行版名>` 后重试。",
  };
}

/** Docker Desktop 的内部发行版名（`docker-desktop` / `docker-desktop-data`）。 */
export function isDockerDesktopDistro(name: string): boolean {
  return /^docker-desktop(-data)?$/i.test(name.trim());
}

/** 解析 `wsl -l -v`：列形如 `* Ubuntu  Running  2`（名前可能有 `*`，列间多空格）。 */
export function parseWslDistros(
  text: string,
): Array<{ name: string; state: string; version: number }> {
  const distros: Array<{ name: string; state: string; version: number }> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^\*?\s*(.+?)\s{2,}(\S+)\s+([12])\s*$/);
    if (!match) continue; // 表头与提示行都落在这里
    const [, name, state, version] = match;
    if (!name || !state || !version) continue;
    distros.push({
      name: name.trim(),
      state,
      version: Number.parseInt(version, 10),
    });
  }
  return distros;
}
