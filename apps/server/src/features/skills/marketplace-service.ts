/**
 * Marketplace Service for skills.sh
 *
 * Skills on skills.sh are NOT npm packages — they are GitHub repositories
 * containing SKILL.md files. The skills.sh platform provides:
 * - A web frontend for browsing/searching skills
 * - A download API that returns skill files as JSON
 *
 * API endpoints:
 * - Download: GET https://skills.sh/api/download/{owner}/{repo}/{slug}
 *   Returns: { files: [{path, contents}], hash }
 *
 * For search, we use the npm registry as a discovery layer (packages with
 * "agent-skill" keyword link back to GitHub repos), then install via
 * GitHub import or skills.sh download API.
 *
 * @module marketplace-service
 */

import {
  type ImportedSkill,
  importFromGitHub,
  importFromTarballUrl,
  parseSkillManifest,
  SkillImportError,
} from "./skill-import-service.js";

// ── Constants ──────────────────────────────────────────────────────────────

const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
const SKILLS_SH_BASE = "https://skills.sh";
const SKILL_KEYWORD = "agent-skill";
const USER_AGENT = "KenFutWork-Marketplace/1.0";
const MAX_PAGE_SIZE = 50;
const FETCH_TIMEOUT_MS = 15_000;

// ── Error Class ────────────────────────────────────────────────────────────

export class MarketplaceError extends Error {
  constructor(
    public readonly code:
      | "search_failed"
      | "package_not_found"
      | "install_failed",
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface MarketplaceSkill {
  packageName: string;
  name: string;
  description: string;
  author: string;
  version: string;
  downloads: number;
  keywords: string[];
  homepage?: string;
  repository?: string;
  license?: string;
}

export interface MarketplaceSearchResult {
  skills: MarketplaceSkill[];
  total: number;
}

export interface MarketplaceSkillDetail extends MarketplaceSkill {
  readme: string;
  versions: string[];
  tarballUrl: string;
  /** GitHub repo URL if discoverable (for skills.sh download API) */
  repoUrl?: string;
}

// ── Internal Helpers ───────────────────────────────────────────────────────

async function registryFetch(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) {
    throw new MarketplaceError(
      "package_not_found",
      `Package not found: ${url}`,
    );
  }
  if (!response.ok) {
    throw new MarketplaceError(
      "search_failed",
      `Registry request failed: ${response.status} for ${url}`,
    );
  }
  return response;
}

/**
 * Try to extract a GitHub repo URL from npm package metadata.
 * Looks at repository field and homepage.
 */
function extractGitHubRepo(pkg: Record<string, unknown>): string | undefined {
  // Check repository field
  const repo = pkg.repository;
  if (typeof repo === "string" && repo.includes("github.com")) {
    return normalizeGitHubUrl(repo);
  }
  if (repo && typeof repo === "object" && "url" in repo) {
    const repoUrl = (repo as { url: string }).url;
    if (repoUrl.includes("github.com")) {
      return normalizeGitHubUrl(repoUrl);
    }
  }
  // Check homepage
  const homepage = pkg.homepage;
  if (typeof homepage === "string" && homepage.includes("github.com")) {
    return normalizeGitHubUrl(homepage);
  }
  return undefined;
}

function normalizeGitHubUrl(raw: string): string {
  // git+https://github.com/owner/repo.git → https://github.com/owner/repo
  // git://github.com/owner/repo.git → https://github.com/owner/repo
  let url = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
  // Ensure https://
  if (url.startsWith("github.com")) {
    url = `https://${url}`;
  }
  return url;
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * 判断一条 npm 结果是否匹配查询词（名称 / 描述 / 关键词，任意词命中即可）。
 *
 * 为什么需要它：npm 的 `text=` 对多词是**相关性排序**而非过滤——查
 * `sheleg-design-skill` 仍返回全部 1061 个 keyword 命中项（目标排第一但列表没变），
 * 用户会以为「搜索无效」。这里在服务端补一层显式过滤。
 */
export function matchesMarketQuery(
  item: { name: string; description: string; keywords: string[] },
  query: string,
): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return true;
  }
  const haystack = [item.name, item.description, item.keywords.join(" ")]
    .join(" ")
    .toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

/**
 * Search the npm registry for skill packages.
 * Uses `keywords:agent-skill` to scope results；带查询词时再做一次显式过滤
 * （npm 只排序不过滤），并多取一些候选以免过滤后为空。
 */
export async function searchMarketplace(
  query: string,
  page: number = 1,
  limit: number = 20,
): Promise<MarketplaceSearchResult> {
  const safePage = Math.max(1, Math.min(page, 100));
  const safeLimit = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
  const offset = (safePage - 1) * safeLimit;
  const trimmedQuery = query.trim();

  const searchText = trimmedQuery
    ? `keywords:${SKILL_KEYWORD} ${trimmedQuery}`
    : `keywords:${SKILL_KEYWORD}`;

  // 带查询词时多取候选（npm 返回的是按相关性排序的全量命中，过滤后可能变少）
  const fetchSize = trimmedQuery
    ? Math.min(Math.max(safeLimit * 3, 50), MAX_PAGE_SIZE)
    : safeLimit;

  const params = new URLSearchParams({
    text: searchText,
    size: String(fetchSize),
    from: String(offset),
  });

  console.log(
    `[marketplace] Searching: query="${query}" page=${safePage} limit=${safeLimit} offset=${offset}`,
  );

  const response = await registryFetch(
    `${NPM_REGISTRY_BASE}/-/v1/search?${params}`,
  );
  const data = (await response.json()) as {
    objects: Array<{
      package: {
        name: string;
        version: string;
        description?: string;
        keywords?: string[];
        author?: { name?: string } | string;
        links?: { npm?: string; homepage?: string; repository?: string };
      };
      score?: { detail?: { popularity?: number } };
    }>;
    total: number;
  };

  const skills: MarketplaceSkill[] = data.objects.map((obj) => {
    const pkg = obj.package;
    const authorName =
      typeof pkg.author === "string"
        ? pkg.author
        : (pkg.author?.name ?? "unknown");

    const result: MarketplaceSkill = {
      packageName: pkg.name,
      name: pkg.name,
      description: pkg.description ?? "",
      author: authorName,
      version: pkg.version,
      downloads: Math.round((obj.score?.detail?.popularity ?? 0) * 20000),
      keywords: pkg.keywords ?? [],
    };
    if (pkg.links?.homepage) result.homepage = pkg.links.homepage;
    if (pkg.links?.repository) result.repository = pkg.links.repository;
    return result;
  });

  // 带查询词：显式过滤后再截断到 limit（避免"搜索无效"的观感）
  const visible = trimmedQuery
    ? skills.filter((item) => matchesMarketQuery(item, trimmedQuery))
    : skills;

  console.log(
    `[marketplace] Search returned ${visible.length} results (fetched: ${skills.length}, total: ${data.total})`,
  );
  return { skills: visible.slice(0, safeLimit), total: data.total };
}

// ── Detail ─────────────────────────────────────────────────────────────────

/**
 * Get full detail for a package from the npm registry.
 */
export async function getMarketplaceDetail(
  packageName: string,
): Promise<MarketplaceSkillDetail> {
  console.log(`[marketplace] Fetching detail for package: ${packageName}`);

  const encoded = encodeURIComponent(packageName).replace("%40", "@");
  const response = await registryFetch(`${NPM_REGISTRY_BASE}/${encoded}`);
  const data = (await response.json()) as Record<string, unknown>;

  const distTags = data["dist-tags"] as Record<string, string> | undefined;
  const latestVersion = distTags?.latest ?? "0.0.0";
  const versions = data.versions as
    | Record<string, Record<string, unknown>>
    | undefined;
  const latestMeta = versions?.[latestVersion];
  const tarballUrl =
    (latestMeta?.dist as { tarball?: string } | undefined)?.tarball ?? "";

  const authorRaw = data.author;
  const authorName =
    typeof authorRaw === "string"
      ? authorRaw
      : ((authorRaw as { name?: string } | undefined)?.name ?? "unknown");

  const repoUrl = extractGitHubRepo(data);

  const result: MarketplaceSkillDetail = {
    packageName,
    name: (data.name as string) ?? packageName,
    description: (data.description as string) ?? "",
    author: authorName,
    version: latestVersion,
    downloads: 0,
    keywords: (data.keywords as string[]) ?? [],
    readme: (data.readme as string) ?? "",
    versions: versions ? Object.keys(versions) : [],
    tarballUrl,
  };

  if (data.license) result.license = data.license as string;
  if (data.homepage) result.homepage = data.homepage as string;
  if (repoUrl) {
    result.repository = repoUrl;
    result.repoUrl = repoUrl;
  }

  console.log(
    `[marketplace] Detail fetched: ${packageName}@${latestVersion} (${result.versions.length} versions, tarball=${tarballUrl})`,
  );

  return result;
}

// ── Install ────────────────────────────────────────────────────────────────

/**
 * Install a skill from the marketplace.
 *
 * Strategy (in order of preference):
 * 1. If package has a GitHub repo link → use skills.sh download API
 * 2. If skills.sh fails → try GitHub import directly
 * 3. Fallback → download npm tarball and extract
 *
 * This multi-strategy approach handles the reality that skills.sh skills
 * are primarily GitHub repos, not npm packages.
 */
export async function installFromMarketplace(
  packageName: string,
): Promise<{ imported: ImportedSkill; packageName: string }> {
  console.log(`[marketplace] Installing skill from package: ${packageName}`);

  const detail = await getMarketplaceDetail(packageName);

  // Strategy 1: Try skills.sh download API if we have a GitHub repo
  if (detail.repoUrl) {
    try {
      const imported = await trySkillsShDownload(detail.repoUrl);
      if (imported) {
        console.log(
          `[marketplace] Installed via skills.sh download API: ${imported.manifest.name}`,
        );
        return { imported, packageName };
      }
    } catch (err) {
      console.log(
        `[marketplace] skills.sh download failed, trying GitHub import: ${err}`,
      );
    }

    // Strategy 2: Try direct GitHub import
    try {
      const imported = await importFromGitHub(detail.repoUrl);
      console.log(
        `[marketplace] Installed via GitHub import: ${imported.manifest.name} (${imported.files.length} files)`,
      );
      return { imported, packageName };
    } catch (err) {
      console.log(
        `[marketplace] GitHub import failed, falling back to npm tarball: ${err}`,
      );
    }
  }

  // Strategy 3: Fallback to npm tarball
  if (!detail.tarballUrl) {
    throw new MarketplaceError(
      "install_failed",
      `No tarball URL available for ${packageName}`,
    );
  }

  try {
    const imported = await importFromTarballUrl(detail.tarballUrl);
    console.log(
      `[marketplace] Installed via npm tarball: ${imported.manifest.name} (${imported.files.length} files)`,
    );
    return { imported, packageName };
  } catch (err) {
    if (err instanceof SkillImportError) {
      throw new MarketplaceError(
        "install_failed",
        `Failed to extract skill from "${packageName}": ${err.message}`,
      );
    }
    throw err;
  }
}

// ── skills.sh Download API ─────────────────────────────────────────────────

/**
 * Try to download a skill via the skills.sh download API.
 *
 * The API returns: { files: [{path, contents}], hash }
 * This is the fastest way to get skill files without cloning a repo.
 */
async function trySkillsShDownload(
  repoUrl: string,
): Promise<ImportedSkill | null> {
  // Parse GitHub URL: https://github.com/owner/repo → owner, repo
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;

  const owner = match[1];
  const repo = match[2];

  // Try to discover skills in the repo via skills.sh
  // skills.sh API: GET /api/download/{owner}/{repo}/{slug}
  // But we don't know the slug yet. Try the repo name as slug first.
  const slug = repo?.replace(/[^a-z0-9-]/gi, "-").toLowerCase() ?? "";

  const downloadUrl = `${SKILLS_SH_BASE}/api/download/${owner}/${repo}/${slug}`;
  console.log(`[marketplace] Trying skills.sh download: ${downloadUrl}`);

  try {
    const response = await fetch(downloadUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.log(
        `[marketplace] skills.sh returned ${response.status} for ${downloadUrl}`,
      );
      return null;
    }

    const data = (await response.json()) as {
      files?: Array<{ path: string; contents: string }>;
      hash?: string;
    };

    if (!data.files?.length) {
      console.log(
        `[marketplace] skills.sh returned empty files for ${downloadUrl}`,
      );
      return null;
    }

    // Find SKILL.md
    const skillMdFile = data.files.find(
      (f) => f.path.toUpperCase() === "SKILL.MD",
    );

    if (!skillMdFile) {
      console.log(
        `[marketplace] No SKILL.md in skills.sh response for ${downloadUrl}`,
      );
      return null;
    }

    const manifest = parseSkillManifest(skillMdFile.contents);

    // Collect scripts/references/assets files
    const ALLOWED_DIR = /^(scripts|references|assets)\//i;
    const files = data.files
      .filter((f) => ALLOWED_DIR.test(f.path))
      .map((f) => ({
        filePath: f.path,
        content: f.contents,
        mimeType: "text/plain",
      }));

    console.log(
      `[marketplace] skills.sh download success: ${manifest.name} (${files.length} files)`,
    );

    return {
      manifest,
      skillContent: skillMdFile.contents,
      files,
      sourceUrl: repoUrl,
    };
  } catch (err) {
    console.log(`[marketplace] skills.sh download error: ${err}`);
    return null;
  }
}
