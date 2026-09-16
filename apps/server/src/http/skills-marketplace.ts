import {
  applicationErrorResponseSchema,
  marketplaceInstallRequestSchema,
  skillDetailResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  SQLSTATE_UNIQUE_VIOLATION,
  SqlError,
} from "../features/persistence/errors.js";
import {
  getMarketplaceDetail,
  installFromMarketplace,
  MarketplaceError,
  searchMarketplace,
} from "../features/skills/marketplace-service.js";
import type { SkillCatalogRepository } from "../features/skills/repository.js";

// ---------------------------------------------------------------------------
// Skill row mappers (duplicated from skills.ts to avoid circular imports)
// ---------------------------------------------------------------------------

type SkillRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  author: string;
  version: string;
  license: string | null;
  category: string;
  icon_name: string | null;
  source: string;
  skill_content: string;
  metadata: Record<string, unknown> | null;
  is_featured: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  source_url: string | null;
  package_name: string | null;
};

function mapSkillRow(row: SkillRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    author: row.author,
    version: row.version,
    category: row.category,
    iconName: row.icon_name,
    source: row.source,
    isFeatured: row.is_featured,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSkillDetailRow(row: SkillRow) {
  return {
    ...mapSkillRow(row),
    license: row.license,
    skillContent: row.skill_content,
    createdBy: row.created_by,
    sourceUrl: row.source_url ?? null,
    packageName: row.package_name ?? null,
  };
}

function mapSkillFileRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    filePath: row.file_path as string,
    content: row.content as string,
    mimeType: row.mime_type as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerMarketplaceRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    /** 安装态与目录的数据访问（persistence 缝）。 */
    skillsRepository: SkillCatalogRepository;
    viewerService: ViewerService;
  },
) {
  // GET /api/skills/marketplace/search — search skills.sh via npm registry
  app.get("/api/skills/marketplace/search", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const {
        q = "",
        page = "1",
        limit = "20",
      } = request.query as Record<string, string>;
      const result = await searchMarketplace(
        q,
        parseInt(page, 10),
        parseInt(limit, 10),
      );
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof MarketplaceError) {
        return sendError(
          reply,
          "marketplace_search_failed",
          error.message,
          502,
        );
      }
      request.log.error({ err: error }, "marketplace search error");
      return sendError(
        reply,
        "marketplace_search_failed",
        "Marketplace search failed.",
      );
    }
  });

  // GET /api/skills/marketplace/detail — get package detail from npm registry
  app.get("/api/skills/marketplace/detail", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { name } = request.query as { name?: string };
      if (!name) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "marketplace_detail_failed",
              message: "Package name is required (use ?name=package-name)",
            },
          }),
        );
      }
      const detail = await getMarketplaceDetail(name);
      return reply.code(200).send(detail);
    } catch (error) {
      if (error instanceof MarketplaceError) {
        const status = error.code === "package_not_found" ? 404 : 502;
        return sendError(
          reply,
          "marketplace_detail_failed",
          error.message,
          status,
        );
      }
      request.log.error({ err: error }, "marketplace detail error");
      return sendError(
        reply,
        "marketplace_detail_failed",
        "Failed to fetch package detail.",
      );
    }
  });

  // POST /api/skills/marketplace/install — install a skill from skills.sh
  app.post("/api/skills/marketplace/install", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { packageName } = marketplaceInstallRequestSchema.parse(
        request.body,
      );
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;

      // Download and parse from npm registry
      const { imported, packageName: pkgName } =
        await installFromMarketplace(packageName);
      const slug = generateSlug(imported.manifest.name);

      // Insert skill
      let skillData: Record<string, unknown> | null;
      try {
        skillData = await options.skillsRepository.insertOwned(user.id, {
          author: imported.manifest.author ?? "unknown",
          category: "custom",
          description: imported.manifest.description,
          license: imported.manifest.license ?? null,
          metadata: {
            ...(imported.manifest.metadata ?? {}),
            source_url: `https://www.npmjs.com/package/${packageName}`,
            package_name: pkgName,
          },
          name: imported.manifest.name,
          skillContent: imported.skillContent,
          slug,
          version: imported.manifest.version ?? "1.0",
        });
      } catch (error) {
        request.log.error(
          { err: error },
          "marketplace install DB insert failed",
        );
        if (
          error instanceof SqlError &&
          error.code === SQLSTATE_UNIQUE_VIOLATION
        ) {
          return sendError(
            reply,
            "marketplace_install_failed",
            "This skill is already installed.",
            409,
          );
        }
        return sendError(
          reply,
          "marketplace_install_failed",
          "Failed to save marketplace skill.",
        );
      }

      if (!skillData) {
        return sendError(
          reply,
          "marketplace_install_failed",
          "Failed to save marketplace skill.",
        );
      }

      const skillId = skillData.id as string;

      // Insert files
      if (imported.files.length > 0) {
        const fileError = await options.skillsRepository
          .insertFilesForOwnedSkill(user.id, skillId, imported.files)
          .then(() => null)
          .catch((caught: unknown) => caught);
        if (fileError) {
          request.log.error(
            { err: fileError },
            "marketplace install file insert failed (non-fatal)",
          );
        }
      }

      // Auto-install to workspace
      await options.skillsRepository.upsertInstallation({
        enabled: true,
        installedBy: user.id,
        skillId,
        workspaceId,
      });

      // Return full skill detail with files
      const fileData = await options.skillsRepository.listFilesForVisibleSkill(
        user.id,
        skillId,
      );

      const skill = {
        ...mapSkillDetailRow(skillData as unknown as SkillRow),
        files: fileData.map(mapSkillFileRow),
      };

      return reply.code(201).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) {
      if (error instanceof MarketplaceError) {
        return sendError(
          reply,
          "marketplace_install_failed",
          error.message,
          502,
        );
      }
      request.log.error({ err: error }, "marketplace install error");
      return sendError(
        reply,
        "marketplace_install_failed",
        "Failed to install marketplace skill.",
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendError(
  reply: FastifyReply,
  code: string,
  message: string,
  statusCode = 500,
) {
  return reply.code(statusCode).send(
    applicationErrorResponseSchema.parse({
      error: { code, message },
    }),
  );
}
