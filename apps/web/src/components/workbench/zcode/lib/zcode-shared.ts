/**
 * zcode 移植层宿主适配：`@zcode/shared` 的最小等价（只收录照搬组件实际消费的切片）。
 * 来源：references/zcode/packages/shared/src/{platform,protocol,remoteTarget,test-ids,markdown-artifact-images}.ts
 * 许可证：Apache-2.0（zcode）。
 * 适配口径：类型逐字照搬；运行时函数（artifact 图片重写 / remoteTarget 构造）为纯函数照搬。
 * 远程连接类型（SSH/WSL/Docker）仅作类型保留——我们宿主暂无远程工作区，platform stub 永远不会返回 remoteTarget。
 */

/* ---------- remoteTarget.ts ---------- */

export interface SSHConnectOptions {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
}

export interface WSLConnectOptions {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerConnectOptions {
  kind: "docker";
  container: string;
}

export type RemoteTarget =
  | SSHConnectOptions
  | WSLConnectOptions
  | DockerConnectOptions;

/* ---------- platform.ts ---------- */

/** 已安装的编辑器/终端信息 */
export interface EditorInfo {
  /** 编辑器标识 (e.g. "vscode", "zed", "terminal") */
  id: string;
  /** 显示名 */
  name: string;
  /** 图标 base64 data URL */
  iconDataUrl: string;
}

export type OpenInEditorRemoteTarget =
  | Pick<
      SSHConnectOptions,
      "kind" | "host" | "port" | "username" | "sshConfigAlias"
    >
  | Pick<WSLConnectOptions, "kind" | "distro" | "user">
  | Pick<DockerConnectOptions, "kind" | "container">;

export interface OpenInEditorOptions {
  remoteTarget?: OpenInEditorRemoteTarget;
  workspaceIdentity?: string;
  pathKind?: "file" | "directory";
}

export function createOpenInEditorRemoteTarget(
  target: RemoteTarget,
): OpenInEditorRemoteTarget {
  switch (target.kind) {
    case "ssh":
      // openInEditor 只需要构造 VS Code Remote-SSH URI 的连接标识，
      // 不应该把 password/privateKeyPassphrase 等凭据字段继续穿过 renderer/preload/main IPC。
      return {
        kind: "ssh",
        host: target.host,
        ...(target.port !== undefined ? { port: target.port } : {}),
        username: target.username,
        ...(target.sshConfigAlias?.trim()
          ? { sshConfigAlias: target.sshConfigAlias.trim() }
          : {}),
      };
    case "wsl": {
      const user = target.user?.trim();
      // exactOptionalPropertyTypes：条件展开在该联合上推断不稳，显式构造。
      const result: {
        kind: "wsl";
        distro?: string;
        user?: string;
      } = { kind: "wsl" };
      if (target.distro !== undefined) result.distro = target.distro;
      if (user) result.user = user;
      return result;
    }
    case "docker":
      return { kind: "docker", container: target.container };
  }
}

/* ---------- protocol.ts ---------- */

export interface FileStat {
  path: string;
  type: "file" | "directory";
  /** 文件字节数；旧远端服务端可能不返回，调用方需按 undefined 处理。 */
  size?: number;
  /** 文件最后修改时间。 */
  mtimeMs?: number;
}

export interface FileMediaPreview {
  path: string;
  mediaType: string;
  dataBase64: string;
  totalBytes: number;
}

/* ---------- test-ids.ts ---------- */

export const TID_CHAT_REASONING_TRIGGER = "chat-reasoning-trigger";
export const TID_CHAT_REASONING_CONTENT = "chat-reasoning-content";

/* ---------- markdown-artifact-images.ts ---------- */

const ARTIFACT_IMAGE_RENDER_PREFIX = "/__zcode_artifact_image__/";
const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
const ARTIFACT_IMAGE_PATTERN =
  /!\[[^\]\n]*\]\(\s*(?:<)?(zcode-artifact:\/\/[^\s)>]+)(?:>)?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;

function mapOutsideMarkdownFences(
  markdown: string,
  transform: (line: string) => string,
): string {
  let activeMarker: "`" | "~" | null = null;
  let activeLength = 0;
  return markdown
    .split("\n")
    .map((line) => {
      const fence = line.match(FENCE_PATTERN);
      if (fence?.[2]) {
        const run = fence[2];
        const marker = run[0] as "`" | "~";
        const suffix = fence[3] ?? "";
        if (
          activeMarker === marker &&
          run.length >= activeLength &&
          suffix.trim() === ""
        ) {
          activeMarker = null;
          activeLength = 0;
        } else if (!activeMarker && (marker === "~" || !suffix.includes("`"))) {
          activeMarker = marker;
          activeLength = run.length;
        }
        return line;
      }
      return activeMarker ? line : transform(line);
    })
    .join("\n");
}

export function extractMarkdownArtifactImageRefs(markdown: string): string[] {
  const refs = new Set<string>();
  mapOutsideMarkdownFences(markdown, (line) => {
    for (const match of line.matchAll(ARTIFACT_IMAGE_PATTERN)) {
      if (match[1]) refs.add(match[1]);
    }
    return line;
  });
  return [...refs];
}

export function rewriteMarkdownArtifactImageSources(markdown: string): string {
  return mapOutsideMarkdownFences(markdown, (line) =>
    line.replace(ARTIFACT_IMAGE_PATTERN, (image, ref: string) =>
      image.replace(
        ref,
        `${ARTIFACT_IMAGE_RENDER_PREFIX}${encodeURIComponent(ref)}`,
      ),
    ),
  );
}

export function decodeMarkdownArtifactImageSource(
  source: string,
): string | null {
  if (!source.startsWith(ARTIFACT_IMAGE_RENDER_PREFIX)) return null;
  try {
    const ref = decodeURIComponent(
      source.slice(ARTIFACT_IMAGE_RENDER_PREFIX.length),
    );
    return ref.startsWith("zcode-artifact://") ? ref : null;
  } catch {
    return null;
  }
}
