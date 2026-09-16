/**
 * Skill Import Service
 *
 * Parses and imports skills from external sources (GitHub repos, npm tarballs).
 * Skills follow the agentskills.io standard: a directory containing SKILL.md
 * (YAML frontmatter + markdown body) plus optional scripts/, references/, assets/.
 *
 * @module skill-import-service
 */

import { load as loadYaml } from "js-yaml";
import { Parser as TarParser } from "tar";
import { readZipArchiveEntries } from "./zip-archive.js";

// ── Types ─────────────────────────────────────────────────────────────────

/** Parsed YAML frontmatter from SKILL.md */
export interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  version?: string;
  author?: string;
  metadata?: Record<string, unknown>;
}

/** A single file included with the skill (scripts/, references/, assets/) */
export interface ImportedSkillFile {
  /** Relative path within the skill directory, e.g. "scripts/analyze.py" */
  filePath: string;
  /** Raw text content */
  content: string;
  /** Detected MIME type based on extension */
  mimeType: string;
}

/** Complete imported skill ready for persistence */
export interface ImportedSkill {
  manifest: SkillManifest;
  /** Full raw SKILL.md content (frontmatter + body) */
  skillContent: string;
  /** Associated files in scripts/, references/, assets/ */
  files: ImportedSkillFile[];
  /** Original URL the skill was imported from */
  sourceUrl: string;
}

/** Classification of an import URL */
export type ImportSourceType = "github" | "npm-tarball" | "zip" | "unknown";

// ── Error Types ───────────────────────────────────────────────────────────

export class SkillImportError extends Error {
  readonly code:
    | "manifest_not_found"
    | "manifest_parse_error"
    | "manifest_validation_error"
    | "github_fetch_error"
    | "tarball_extract_error"
    | "zip_extract_error"
    | "save_failed"
    | "unsupported_source";

  constructor(code: SkillImportError["code"], message: string) {
    super(message);
    this.name = "SkillImportError";
    this.code = code;
  }
}

// ── MIME Type Detection ───────────────────────────────────────────────────

const EXTENSION_MIME_MAP: Record<string, string> = {
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".md": "text/markdown",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".sql": "text/x-sql",
  ".r": "text/x-r",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".kt": "text/x-kotlin",
  ".swift": "text/x-swift",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".env": "text/plain",
};

/** Binary extensions that should be skipped during text-based import */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
]);

function detectMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? "text/plain";
}

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// ── Frontmatter Parser ────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from SKILL.md content.
 *
 * Expects the file to start with `---` followed by YAML, then `---` to close.
 * Everything after the closing `---` is the markdown body.
 *
 * @throws SkillImportError if frontmatter is missing or invalid
 */
export function parseSkillManifest(skillMdContent: string): SkillManifest {
  const trimmed = skillMdContent.trimStart();

  if (!trimmed.startsWith("---")) {
    throw new SkillImportError(
      "manifest_parse_error",
      "Invalid SKILL.md: missing YAML frontmatter (file must start with '---')",
    );
  }

  // Find the closing --- (skip the opening one)
  const closingIndex = trimmed.indexOf("\n---", 3);
  if (closingIndex === -1) {
    throw new SkillImportError(
      "manifest_parse_error",
      "Invalid SKILL.md: missing closing '---' for YAML frontmatter",
    );
  }

  const yamlBlock = trimmed.slice(3, closingIndex).trim();
  if (!yamlBlock) {
    throw new SkillImportError(
      "manifest_parse_error",
      "Invalid SKILL.md: empty YAML frontmatter block",
    );
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(yamlBlock);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillImportError(
      "manifest_parse_error",
      `Invalid SKILL.md: YAML parse error - ${message}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new SkillImportError(
      "manifest_parse_error",
      "Invalid SKILL.md: frontmatter must be a YAML mapping",
    );
  }

  const raw = parsed as Record<string, unknown>;

  // Validate required fields
  if (!raw.name || typeof raw.name !== "string") {
    throw new SkillImportError(
      "manifest_validation_error",
      "Invalid SKILL.md frontmatter: missing required field 'name'",
    );
  }
  if (!raw.description || typeof raw.description !== "string") {
    throw new SkillImportError(
      "manifest_validation_error",
      "Invalid SKILL.md frontmatter: missing required field 'description'",
    );
  }

  const manifest: SkillManifest = {
    name: raw.name,
    description: raw.description,
  };

  // Only assign optional fields when present (exactOptionalPropertyTypes)
  if (typeof raw.license === "string") manifest.license = raw.license;
  if (typeof raw.version === "string") manifest.version = raw.version;
  if (typeof raw.author === "string") manifest.author = raw.author;
  if (isPlainObject(raw.metadata)) {
    manifest.metadata = raw.metadata as Record<string, unknown>;
  }

  return manifest;
}

// ── URL Type Detection ────────────────────────────────────────────────────

/**
 * Detect the import source type from a URL string.
 *
 * - GitHub: matches github.com/{owner}/{repo}
 * - npm tarball: ends with .tgz/.tar.gz, or contains registry.npmjs.org
 * - zip: ends with .zip or .skill
 * - unknown: anything else
 */
export function detectImportSource(url: string): ImportSourceType {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  // GitHub detection
  if (hostname === "github.com" || hostname === "www.github.com") {
    return "github";
  }

  // npm tarball detection
  if (hostname === "registry.npmjs.org") {
    return "npm-tarball";
  }
  if (pathname.endsWith(".tgz") || pathname.endsWith(".tar.gz")) {
    return "npm-tarball";
  }

  // ZIP detection (future support)
  if (pathname.endsWith(".zip") || pathname.endsWith(".skill")) {
    return "zip";
  }

  return "unknown";
}

// ── GitHub Importer ───────────────────────────────────────────────────────

/** Parsed components from a GitHub URL */
interface GitHubUrlInfo {
  owner: string;
  repo: string;
  /** Optional path within the repo, e.g. "skills/my-skill" */
  path: string;
  /** Branch/ref extracted from the URL, e.g. "main" */
  ref: string | null;
}

/** GitHub Contents API response item */
interface GitHubContentItem {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
  size: number;
}

/**
 * Parse a GitHub URL into its constituent parts.
 *
 * Supported formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/main/path/to/skill
 * - https://github.com/owner/repo/tree/branch/path
 */
function parseGitHubUrl(url: string): GitHubUrlInfo {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

  if (segments.length < 2) {
    throw new SkillImportError(
      "github_fetch_error",
      `Invalid GitHub URL: expected github.com/{owner}/{repo}, got: ${url}`,
    );
  }

  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, "");

  // Default: root of the repo, no specific ref
  let ref: string | null = null;
  let path = "";

  // Handle /tree/{ref}/... or /blob/{ref}/... patterns
  if (
    segments.length >= 4 &&
    (segments[2] === "tree" || segments[2] === "blob")
  ) {
    ref = segments[3]!;
    path = segments.slice(4).join("/");
  } else if (segments.length > 2) {
    // Fallback: treat remaining segments as a path
    path = segments.slice(2).join("/");
  }

  return { owner, repo, ref, path };
}

/**
 * Fetch a resource from the GitHub API with rate-limit awareness.
 *
 * @throws SkillImportError on non-2xx responses
 */
async function githubApiFetch(url: string): Promise<Response> {
  console.log(`[skill-import] GitHub API request: ${url}`);

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "KenFutWork-Skill-Importer/1.0",
    },
  });

  if (!response.ok) {
    // Provide helpful messages for common error codes
    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 403 && rateLimitRemaining === "0") {
      const resetTime = response.headers.get("x-ratelimit-reset");
      const resetDate = resetTime
        ? new Date(Number(resetTime) * 1000).toISOString()
        : "unknown";
      throw new SkillImportError(
        "github_fetch_error",
        `GitHub API rate limit exceeded. Resets at ${resetDate}. Consider using a GitHub token.`,
      );
    }

    if (response.status === 404) {
      throw new SkillImportError(
        "github_fetch_error",
        `GitHub repository or path not found: ${url}`,
      );
    }

    throw new SkillImportError(
      "github_fetch_error",
      `Failed to fetch GitHub repository: HTTP ${response.status} ${response.statusText}`,
    );
  }

  return response;
}

/**
 * List directory contents using the GitHub Contents API.
 */
async function listGitHubDirectory(
  owner: string,
  repo: string,
  path: string,
  ref: string | null,
): Promise<GitHubContentItem[]> {
  const encodedPath = path
    ? `/${encodeURIComponent(path).replace(/%2F/g, "/")}`
    : "";
  let apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents${encodedPath}`;
  if (ref) {
    apiUrl += `?ref=${encodeURIComponent(ref)}`;
  }

  const response = await githubApiFetch(apiUrl);
  const data: unknown = await response.json();

  if (!Array.isArray(data)) {
    // Single file response — wrap as array for consistent handling
    return [data as GitHubContentItem];
  }

  return data as GitHubContentItem[];
}

/**
 * Download a file's text content from its download_url.
 */
async function downloadGitHubFile(downloadUrl: string): Promise<string> {
  const response = await fetch(downloadUrl, {
    headers: { "User-Agent": "KenFutWork-Skill-Importer/1.0" },
  });

  if (!response.ok) {
    throw new SkillImportError(
      "github_fetch_error",
      `Failed to download file from GitHub: HTTP ${response.status} for ${downloadUrl}`,
    );
  }

  return response.text();
}

/**
 * Recursively collect files from a GitHub directory that match
 * the allowed subdirectory pattern (scripts/, references/, assets/).
 */
async function collectGitHubFiles(
  owner: string,
  repo: string,
  basePath: string,
  ref: string | null,
  parentRelative: string,
): Promise<ImportedSkillFile[]> {
  const items = await listGitHubDirectory(owner, repo, basePath, ref);
  const files: ImportedSkillFile[] = [];

  for (const item of items) {
    const relativePath = parentRelative
      ? `${parentRelative}/${item.name}`
      : item.name;

    if (item.type === "file") {
      // Skip binary files
      if (isBinaryFile(item.name)) {
        console.log(`[skill-import] Skipping binary file: ${relativePath}`);
        continue;
      }

      if (!item.download_url) {
        console.warn(`[skill-import] No download URL for file: ${item.path}`);
        continue;
      }

      const content = await downloadGitHubFile(item.download_url);
      files.push({
        filePath: relativePath,
        content,
        mimeType: detectMimeType(item.name),
      });
    } else if (item.type === "dir") {
      // Recurse into subdirectories
      const nested = await collectGitHubFiles(
        owner,
        repo,
        item.path,
        ref,
        relativePath,
      );
      files.push(...nested);
    }
    // Skip symlinks and submodules silently
  }

  return files;
}

/**
 * Import a skill from a GitHub repository URL.
 *
 * Supports URLs pointing to:
 * - A repo root containing SKILL.md
 * - A subdirectory within a repo containing SKILL.md
 *
 * Downloads SKILL.md and all files under scripts/, references/, assets/.
 */
export async function importFromGitHub(
  repoUrl: string,
): Promise<ImportedSkill> {
  const { owner, repo, path, ref } = parseGitHubUrl(repoUrl);
  console.log(
    `[skill-import] Importing from GitHub: ${owner}/${repo} path="${path}" ref="${ref ?? "default"}"`,
  );

  // Step 1: List the target directory contents
  const contents = await listGitHubDirectory(owner, repo, path, ref);

  // Step 2: Find SKILL.md
  const skillMdItem = contents.find(
    (item) => item.type === "file" && item.name.toUpperCase() === "SKILL.MD",
  );

  if (!skillMdItem?.download_url) {
    throw new SkillImportError(
      "manifest_not_found",
      `SKILL.md not found in repository: ${owner}/${repo}/${path}`,
    );
  }

  const skillContent = await downloadGitHubFile(skillMdItem.download_url);
  const manifest = parseSkillManifest(skillContent);

  console.log(
    `[skill-import] Parsed manifest: name="${manifest.name}" version="${manifest.version ?? "unversioned"}"`,
  );

  // Step 3: Collect files from allowed subdirectories
  const allowedDirs = ["scripts", "references", "assets"];
  const files: ImportedSkillFile[] = [];

  for (const item of contents) {
    if (item.type !== "dir" || !allowedDirs.includes(item.name.toLowerCase())) {
      continue;
    }

    const dirFiles = await collectGitHubFiles(
      owner,
      repo,
      item.path,
      ref,
      item.name,
    );
    files.push(...dirFiles);
  }

  console.log(
    `[skill-import] GitHub import complete: ${files.length} files collected from ${owner}/${repo}`,
  );

  return {
    manifest,
    skillContent,
    files,
    sourceUrl: repoUrl,
  };
}

// ── Archive (tarball / zip) Importer ──────────────────────────────────────

/** In-memory file extracted from an archive (tarball or zip). */
interface ArchiveEntry {
  /** Path within the archive (after stripping the root prefix) */
  path: string;
  /** Raw text content */
  content: string;
}

/**
 * Extract text files from a .tgz/.tar.gz tarball in memory.
 *
 * npm tarballs typically have a `package/` prefix on all paths;
 * this is automatically detected and stripped.
 */
async function extractTarballEntries(buffer: Buffer): Promise<ArchiveEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ArchiveEntry[] = [];
    let rootPrefix: string | null = null;

    const parser = new TarParser({
      // Let tar auto-detect gzip compression
      onReadEntry(entry) {
        const entryPath = entry.path;

        // Skip directories
        if (entry.type === "Directory") {
          // Detect root prefix from first directory (e.g. "package/")
          if (rootPrefix === null && entryPath.endsWith("/")) {
            rootPrefix = entryPath;
          }
          entry.resume();
          return;
        }

        // Only process regular files
        if (entry.type !== "File") {
          entry.resume();
          return;
        }

        // Collect the entry's data chunks
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        entry.on("end", () => {
          const fullContent = Buffer.concat(chunks);

          // Detect root prefix from first file if we haven't seen a directory
          if (rootPrefix === null) {
            const firstSlash = entryPath.indexOf("/");
            if (firstSlash !== -1) {
              rootPrefix = entryPath.slice(0, firstSlash + 1);
            }
          }

          entries.push({
            path: entryPath,
            content: fullContent.toString("utf-8"),
          });
        });
      },
    });

    parser.on("error", (err: Error) => {
      reject(
        new SkillImportError(
          "tarball_extract_error",
          `Failed to extract tarball: ${err.message}`,
        ),
      );
    });

    parser.on("end", () => {
      // Strip root prefix from all paths if one was detected
      if (rootPrefix) {
        for (const entry of entries) {
          if (entry.path.startsWith(rootPrefix)) {
            entry.path = entry.path.slice(rootPrefix.length);
          }
        }
      }

      resolve(entries);
    });

    // Feed the buffer into the parser
    parser.write(buffer);
    parser.end();
  });
}

/**
 * Import a skill from a .tgz/.tar.gz URL (typically an npm tarball).
 *
 * Downloads the tarball, extracts SKILL.md, and collects files under
 * scripts/, references/, assets/.
 */
export async function importFromTarballUrl(
  url: string,
): Promise<ImportedSkill> {
  console.log(`[skill-import] Downloading tarball: ${url}`);

  const response = await fetch(url, {
    headers: { "User-Agent": "KenFutWork-Skill-Importer/1.0" },
  });

  if (!response.ok) {
    throw new SkillImportError(
      "tarball_extract_error",
      `Failed to download tarball: HTTP ${response.status} ${response.statusText} for ${url}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  console.log(
    `[skill-import] Tarball downloaded: ${(buffer.length / 1024).toFixed(1)} KB, extracting...`,
  );

  const entries = await extractTarballEntries(buffer);
  const imported = buildSkillFromArchiveEntries(entries, {
    label: "tarball",
    url,
  });

  console.log(
    `[skill-import] Tarball import complete: ${imported.files.length} files collected from ${url}`,
  );

  return imported;
}

/**
 * 从压缩包条目构建技能（tarball 与 zip 共用）。
 *
 * 两个来源的差异只在「怎么拿到条目」，之后完全同构：
 * 找 SKILL.md（根或子目录）→ 无则回落 package.json + README → 收集
 * scripts/references/assets 下的文本文件。共用一份避免两条路径漂移。
 */
function buildSkillFromArchiveEntries(
  entries: ArchiveEntry[],
  source: { label: "tarball" | "zip" | "sandbox"; url: string },
): ImportedSkill {
  const { label, url } = source;

  // Find SKILL.md (case-insensitive, at the root level after prefix stripping)
  const skillMdEntry = entries.find((e) => e.path.toUpperCase() === "SKILL.MD");

  // Also look for SKILL.md in subdirectories (multi-skill packages like skills/xxx/SKILL.md)
  const nestedSkillMd = !skillMdEntry
    ? entries.find((e) => /\/SKILL\.MD$/i.test(e.path))
    : null;

  // Fallback: use README.md + package.json when no SKILL.md exists
  const readmeEntry = entries.find((e) => e.path.toUpperCase() === "README.MD");
  const pkgJsonEntry = entries.find((e) => e.path === "package.json");

  const effectiveSkillMd = skillMdEntry ?? nestedSkillMd;

  let manifest: SkillManifest;
  let skillContent: string;

  if (effectiveSkillMd) {
    manifest = parseSkillManifest(effectiveSkillMd.content);
    skillContent = effectiveSkillMd.content;
  } else if (pkgJsonEntry) {
    // Fallback: build manifest from package.json + use README as content
    let pkgJson: Record<string, unknown>;
    try {
      pkgJson = JSON.parse(pkgJsonEntry.content) as Record<string, unknown>;
    } catch {
      throw new SkillImportError(
        "manifest_parse_error",
        `Failed to parse package.json in tarball: ${url}`,
      );
    }
    const pkgName = (pkgJson.name as string) ?? "unknown-skill";
    const shortName = pkgName.replace(/^@[^/]+\//, ""); // strip scope
    manifest = {
      name: shortName,
      description: (pkgJson.description as string) ?? "Imported from npm",
    };
    if (pkgJson.version) manifest.version = pkgJson.version as string;
    if (pkgJson.license) manifest.license = pkgJson.license as string;
    if (typeof pkgJson.author === "string") manifest.author = pkgJson.author;
    else if (
      pkgJson.author &&
      typeof (pkgJson.author as any).name === "string"
    ) {
      manifest.author = (pkgJson.author as any).name;
    }

    // Use README.md as skill content, or a minimal placeholder
    skillContent =
      readmeEntry?.content ?? `# ${shortName}\n\n${manifest.description}`;

    console.log(
      `[skill-import] No SKILL.md found, using package.json + README.md fallback for "${shortName}"`,
    );
  } else {
    throw new SkillImportError(
      "manifest_not_found",
      `Neither SKILL.md nor package.json found in ${label}: ${url}`,
    );
  }

  console.log(
    `[skill-import] Parsed ${label} manifest: name="${manifest.name}" version="${manifest.version ?? "unversioned"}"`,
  );

  // Collect files from allowed subdirectories
  const ALLOWED_DIR_PATTERN = /^(scripts|references|assets)\//i;

  const files: ImportedSkillFile[] = entries
    .filter((entry) => {
      // Must be in an allowed subdirectory
      if (!ALLOWED_DIR_PATTERN.test(entry.path)) return false;
      // Must not be binary
      if (isBinaryFile(entry.path)) return false;
      return true;
    })
    .map((entry) => ({
      filePath: entry.path,
      content: entry.content,
      mimeType: detectMimeType(entry.path),
    }));

  return {
    manifest,
    skillContent,
    files,
    sourceUrl: url,
  };
}

/**
 * 由「已在内存里的文件列表」构建技能（从**工作目录**导入 / 创造模式的产物）。
 *
 * 直接复用档案包构建器：SKILL.md 判定、frontmatter 解析、`scripts|references|assets`
 * 附带文件与二进制过滤口径与 zip/tarball 完全一致——两条导入路径不会各自漂移。
 *
 * @param files 相对**技能包根**的文件（`path` 用 `/` 分隔）
 * @param source 来源标签与来源标识（sandbox 导入用 `sandbox:<相对路径>`）
 */
export function buildSkillFromFiles(
  files: Array<{ path: string; content: string }>,
  source: { label: "tarball" | "zip" | "sandbox"; url: string },
): ImportedSkill {
  return buildSkillFromArchiveEntries(files, source);
}

// ── ZIP Importer ──────────────────────────────────────────────────────────
/**
 * Import a skill from a .zip / .skill URL.
 *
 * 与 tarball 的差异只在解包方式（见 zip-archive.ts 的自研最小读取器：
 * 不引第三方依赖，明确拒绝加密/Zip64/越界路径/超限体积）。
 */
export async function importFromZipUrl(url: string): Promise<ImportedSkill> {
  console.log(`[skill-import] Downloading zip: ${url}`);

  const response = await fetch(url, {
    headers: { "User-Agent": "KenFutWork-Skill-Importer/1.0" },
  });

  if (!response.ok) {
    throw new SkillImportError(
      "zip_extract_error",
      `Failed to download zip: HTTP ${response.status} ${response.statusText} for ${url}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(
    `[skill-import] Zip downloaded: ${(buffer.length / 1024).toFixed(1)} KB, extracting...`,
  );

  let entries: ArchiveEntry[];
  try {
    entries = readZipArchiveEntries(buffer);
  } catch (error) {
    throw new SkillImportError(
      "zip_extract_error",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 单层包裹目录（常见于「右键压缩文件夹」产物）：路径统一去掉首层前缀，
  // 否则 SKILL.md 会被当成子目录文件而找不到（tarball 有 package/ 前缀的同类处理）
  const stripped = stripSingleRootPrefix(entries);
  const imported = buildSkillFromArchiveEntries(stripped, {
    label: "zip",
    url,
  });

  console.log(
    `[skill-import] Zip import complete: ${imported.files.length} files collected from ${url}`,
  );

  return imported;
}

/** 若所有条目共享同一层根目录前缀（如 `my-skill/`），统一剥掉。 */
function stripSingleRootPrefix(entries: ArchiveEntry[]): ArchiveEntry[] {
  const firstSlash = entries[0]?.path.indexOf("/") ?? -1;
  if (firstSlash <= 0) {
    return entries;
  }
  const prefix = entries[0]?.path.slice(0, firstSlash + 1) ?? "";
  if (!prefix || !entries.every((entry) => entry.path.startsWith(prefix))) {
    return entries;
  }
  return entries.map((entry) => ({
    ...entry,
    path: entry.path.slice(prefix.length),
  }));
}

// ── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Import a skill from a URL. Automatically detects the source type and
 * delegates to the appropriate importer.
 *
 * @param url GitHub repo URL or tarball URL
 * @returns Parsed skill with manifest, content, and associated files
 * @throws SkillImportError for all import failures
 *
 * @example
 * ```ts
 * const skill = await importSkillFromUrl("https://github.com/user/repo/tree/main/skills/my-skill");
 * console.log(skill.manifest.name); // "my-skill"
 * ```
 */
export async function importSkillFromUrl(url: string): Promise<ImportedSkill> {
  const source = detectImportSource(url);

  console.log(
    `[skill-import] Import requested: url="${url}" detected="${source}"`,
  );

  switch (source) {
    case "github":
      return importFromGitHub(url);

    case "npm-tarball":
      return importFromTarballUrl(url);

    case "zip":
      return importFromZipUrl(url);

    case "unknown":
      throw new SkillImportError(
        "unsupported_source",
        `Unsupported import URL format: ${url}. Supported: GitHub repos, npm tarballs (.tgz/.tar.gz), zip archives (.zip/.skill)`,
      );
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
