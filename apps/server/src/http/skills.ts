import {
  applicationErrorResponseSchema,
  skillCreateRequestSchema,
  skillDetailResponseSchema,
  skillImportRequestSchema,
  skillListResponseSchema,
  skillUpdateRequestSchema,
  unauthenticatedErrorResponseSchema,
  workspaceSkillListResponseSchema,
  workspaceSkillToggleRequestSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  SQLSTATE_UNIQUE_VIOLATION,
  SqlError,
} from "../features/persistence/errors.js";
import type { SkillCatalogRepository } from "../features/skills/repository.js";
import {
  importSkillFromUrl,
  SkillImportError,
} from "../features/skills/skill-import-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

type SkillErrorCode =
  | "skill_not_found"
  | "skill_create_failed"
  | "skill_update_failed"
  | "skill_delete_failed"
  | "skill_query_failed"
  | "skill_file_query_failed"
  | "skill_import_failed"
  | "skill_install_failed"
  | "skill_uninstall_failed"
  | "skill_toggle_failed";

export async function registerSkillRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    /** 安装态与目录的数据访问（persistence 缝）。 */
    skillsRepository: SkillCatalogRepository;
    viewerService: ViewerService;
  },
) {
  // =========================================================================
  // Skills Registry (public catalog)
  // =========================================================================

  // GET /api/skills — list all available skills
  app.get("/api/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      let data: Awaited<
        ReturnType<typeof options.skillsRepository.listVisible>
      >;
      try {
        data = await options.skillsRepository.listVisible(user.id);
      } catch (error) {
        request.log.error({ err: error }, "skills list query failed");
        return sendSkillError(
          reply,
          "skill_query_failed",
          "Unable to load skills.",
        );
      }

      const skills = (data as unknown as SkillRow[]).map(mapSkillRow);
      return reply.code(200).send(skillListResponseSchema.parse({ skills }));
    } catch (error) {
      request.log.error({ err: error }, "skills list error");
      return sendSkillError(
        reply,
        "skill_query_failed",
        "Unable to load skills.",
      );
    }
  });

  // GET /api/skills/:id — get skill detail
  app.get("/api/skills/:id", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { id } = request.params as { id: string };
      let data: Awaited<
        ReturnType<typeof options.skillsRepository.findVisibleById>
      >;
      try {
        data = await options.skillsRepository.findVisibleById(user.id, id);
      } catch (error) {
        request.log.error({ err: error }, "skill detail query failed");
        return sendSkillError(
          reply,
          "skill_query_failed",
          "Unable to load skill.",
        );
      }

      if (!data) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found.",
          404,
        );
      }

      // Fetch associated files（经父链可见性；不含跨用户 skill 的文件）
      const fileData = await options.skillsRepository.listFilesForVisibleSkill(
        user.id,
        id,
      );

      const skill = {
        ...mapSkillDetailRow(data as unknown as SkillRow),
        files: fileData.map(mapSkillFileRow),
      };
      return reply.code(200).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) {
      request.log.error({ err: error }, "skill detail error");
      return sendSkillError(
        reply,
        "skill_query_failed",
        "Unable to load skill.",
      );
    }
  });

  // GET /api/skills/:id/files — list all files for a skill
  app.get("/api/skills/:id/files", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { id } = request.params as { id: string };

      let data: Awaited<
        ReturnType<typeof options.skillsRepository.listFilesForVisibleSkill>
      >;
      try {
        data = await options.skillsRepository.listFilesForVisibleSkill(
          user.id,
          id,
        );
      } catch (error) {
        request.log.error({ err: error }, "skill files list failed");
        return sendSkillError(
          reply,
          "skill_file_query_failed",
          "Unable to load skill files.",
        );
      }

      return reply.code(200).send({ files: data.map(mapSkillFileRow) });
    } catch (error) {
      request.log.error({ err: error }, "skill files list error");
      return sendSkillError(
        reply,
        "skill_file_query_failed",
        "Unable to load skill files.",
      );
    }
  });

  // POST /api/skills — create custom skill
  app.post("/api/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const payload = skillCreateRequestSchema.parse(request.body);
      const slug = generateSlug(payload.name);

      let data: Record<string, unknown> | null;
      try {
        data = await options.skillsRepository.insertOwned(user.id, {
          category: payload.category,
          description: payload.description,
          iconName: payload.iconName ?? null,
          name: payload.name,
          skillContent: payload.skillContent,
          slug,
        });
      } catch (error) {
        request.log.error({ err: error }, "skill create failed");
        if (
          error instanceof SqlError &&
          error.code === SQLSTATE_UNIQUE_VIOLATION
        ) {
          return sendSkillError(
            reply,
            "skill_create_failed",
            "A skill with a similar name already exists. Please choose a different name.",
            409,
          );
        }
        return sendSkillError(
          reply,
          "skill_create_failed",
          "Unable to create skill.",
        );
      }

      if (!data) {
        return sendSkillError(
          reply,
          "skill_create_failed",
          "Unable to create skill.",
        );
      }

      const skillId = data.id as string;

      // Insert associated files if provided
      if (payload.files?.length) {
        const fileError = await options.skillsRepository
          .insertFilesForOwnedSkill(user.id, skillId, payload.files)
          .then(() => null)
          .catch((caught: unknown) => caught);
        if (fileError) {
          // Non-fatal: skill was created but files failed — log and continue
          request.log.error(
            { err: fileError },
            "skill file insert failed (non-fatal)",
          );
        }
      }

      // Fetch files back so the response includes them
      const fileData = await options.skillsRepository.listFilesForVisibleSkill(
        user.id,
        skillId,
      );

      const skill = {
        ...mapSkillDetailRow(data as unknown as SkillRow),
        files: fileData.map(mapSkillFileRow),
      };
      return reply.code(201).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) {
      if (isZodError(error)) {
        return reply.code(400).send({
          issues: error.issues,
          message: "Invalid request body",
        });
      }

      request.log.error({ err: error }, "skill create error");
      return sendSkillError(
        reply,
        "skill_create_failed",
        "Unable to create skill.",
      );
    }
  });

  // POST /api/skills/import — import skill from external URL (GitHub, npm tarball)
  app.post("/api/skills/import", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { url } = skillImportRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;

      // Import skill from external URL (downloads SKILL.md + associated files)
      const imported = await importSkillFromUrl(url);

      const slug = generateSlug(imported.manifest.name);

      // Persist skill to DB
      let skillData: Record<string, unknown> | null;
      try {
        skillData = await options.skillsRepository.insertOwned(user.id, {
          author: imported.manifest.author ?? "unknown",
          category: "custom",
          description: imported.manifest.description,
          license: imported.manifest.license ?? null,
          metadata: {
            ...(imported.manifest.metadata ?? {}),
            source_url: imported.sourceUrl,
          },
          name: imported.manifest.name,
          skillContent: imported.skillContent,
          slug,
          version: imported.manifest.version ?? "1.0",
        });
      } catch (error) {
        request.log.error({ err: error }, "skill import DB insert failed");
        if (
          error instanceof SqlError &&
          error.code === SQLSTATE_UNIQUE_VIOLATION
        ) {
          return sendSkillError(
            reply,
            "skill_import_failed",
            "A skill with this name already exists.",
            409,
          );
        }
        return sendSkillError(
          reply,
          "skill_import_failed",
          "Failed to save imported skill.",
        );
      }

      if (!skillData) {
        return sendSkillError(
          reply,
          "skill_import_failed",
          "Failed to save imported skill.",
        );
      }

      const skillId = skillData.id as string;

      // Insert associated files (scripts/, references/, assets/)
      if (imported.files.length > 0) {
        const fileError = await options.skillsRepository
          .insertFilesForOwnedSkill(user.id, skillId, imported.files)
          .then(() => null)
          .catch((caught: unknown) => caught);
        if (fileError) {
          // Non-fatal: skill record was created but file inserts failed
          request.log.error(
            { err: fileError },
            "skill import file insert failed (non-fatal)",
          );
        }
      }

      // Auto-install imported skill to the user's current workspace
      await options.skillsRepository.upsertInstallation({
        enabled: true,
        installedBy: user.id,
        skillId,
        workspaceId,
      });

      // Fetch files back so the response includes them
      const fileData = await options.skillsRepository.listFilesForVisibleSkill(
        user.id,
        skillId,
      );

      const skill = {
        ...mapSkillDetailRow(skillData as unknown as SkillRow),
        files: fileData.map(mapSkillFileRow),
      };

      request.log.info(
        { skillId, sourceUrl: url },
        "skill imported successfully",
      );
      return reply.code(201).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) {
      if (isZodError(error)) {
        return reply.code(400).send({
          issues: (error as { issues: unknown[] }).issues,
          message: "Invalid request body",
        });
      }
      if (error instanceof SkillImportError) {
        request.log.warn(
          { code: error.code, message: error.message },
          "skill import rejected",
        );
        return sendSkillError(reply, "skill_import_failed", error.message, 400);
      }
      request.log.error({ err: error }, "skill import error");
      return sendSkillError(
        reply,
        "skill_import_failed",
        "Failed to import skill.",
      );
    }
  });

  // PUT /api/skills/:id — update custom skill
  app.put("/api/skills/:id", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { id } = request.params as { id: string };
      const payload = skillUpdateRequestSchema.parse(request.body);

      // Build the update object with only provided fields
      const updates: Record<string, unknown> = {};
      if (payload.name !== undefined) {
        updates.name = payload.name;
        updates.slug = generateSlug(payload.name);
      }
      if (payload.description !== undefined)
        updates.description = payload.description;
      if (payload.category !== undefined) updates.category = payload.category;
      if (payload.skillContent !== undefined)
        updates.skill_content = payload.skillContent;
      if (payload.iconName !== undefined) updates.icon_name = payload.iconName;

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "skill_update_failed",
              message: "No fields to update.",
            },
          }),
        );
      }

      let data: Record<string, unknown> | null;
      let error: unknown;
      try {
        // 仅本人创建的行；created_by 谓词写在语句里，不靠 RLS
        data = await options.skillsRepository.updateOwnedById(
          user.id,
          id,
          updates,
        );
        error = null;
      } catch (caught) {
        data = null;
        error = caught;
      }

      if (error) {
        request.log.error({ err: error }, "skill update failed");
        if ((error as { code?: string }).code === "23505") {
          return sendSkillError(
            reply,
            "skill_update_failed",
            "A skill with a similar name already exists.",
            409,
          );
        }
        return sendSkillError(
          reply,
          "skill_update_failed",
          "Unable to update skill.",
        );
      }

      if (!data) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found or you do not have permission to update it.",
          404,
        );
      }

      const skill = mapSkillDetailRow(data as unknown as SkillRow);
      return reply.code(200).send(skillDetailResponseSchema.parse({ skill }));
    } catch (error) {
      if (isZodError(error)) {
        return reply.code(400).send({
          issues: error.issues,
          message: "Invalid request body",
        });
      }

      request.log.error({ err: error }, "skill update error");
      return sendSkillError(
        reply,
        "skill_update_failed",
        "Unable to update skill.",
      );
    }
  });

  // DELETE /api/skills/:id — delete custom skill
  app.delete("/api/skills/:id", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { id } = request.params as { id: string };
      let count: number;
      try {
        // 仅本人创建的行（created_by 谓词写在语句里，不靠 RLS）
        count = await options.skillsRepository.deleteOwnedById(user.id, id);
      } catch (error) {
        request.log.error({ err: error }, "skill delete failed");
        return sendSkillError(
          reply,
          "skill_delete_failed",
          "Unable to delete skill.",
        );
      }

      if (count === 0) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found or you do not have permission to delete it.",
          404,
        );
      }

      return reply.code(204).send();
    } catch (error) {
      request.log.error({ err: error }, "skill delete error");
      return sendSkillError(
        reply,
        "skill_delete_failed",
        "Unable to delete skill.",
      );
    }
  });

  // =========================================================================
  // Workspace Skills (per-workspace installation)
  // =========================================================================

  // GET /api/workspaces/skills — list installed skills for current workspace
  app.get("/api/workspaces/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;
      let data: Awaited<
        ReturnType<typeof options.skillsRepository.listInstalled>
      >;
      try {
        data = await options.skillsRepository.listInstalled(workspaceId);
      } catch (error) {
        request.log.error({ err: error }, "workspace skills list query failed");
        return sendSkillError(
          reply,
          "skill_query_failed",
          "Unable to load workspace skills.",
        );
      }

      const skills = (
        (data ?? []) as Array<{
          enabled: boolean;
          installed_at: string;
          skills: SkillRow | null;
        }>
      )
        .filter((row) => row.skills !== null)
        .map((row) => {
          const s = row.skills as SkillRow;
          return {
            ...mapSkillRow(s),
            installed: true,
            enabled: row.enabled,
            installedAt: row.installed_at,
          };
        });

      return reply
        .code(200)
        .send(workspaceSkillListResponseSchema.parse({ skills }));
    } catch (error) {
      request.log.error({ err: error }, "workspace skills list error");
      return sendSkillError(
        reply,
        "skill_query_failed",
        "Unable to load workspace skills.",
      );
    }
  });

  // POST /api/workspaces/skills — install a skill
  app.post("/api/workspaces/skills", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const body = request.body as { skillId?: string };
      if (!body.skillId || typeof body.skillId !== "string") {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "skill_install_failed",
              message: "skillId is required.",
            },
          }),
        );
      }

      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;
      // Verify skill exists（可见 = 内置/社区 或 自己创建，与 RLS 读策略同义）
      let skill: { id: string } | null;
      try {
        skill = await options.skillsRepository.findVisibleSkill(
          user.id,
          body.skillId,
        );
      } catch {
        skill = null;
      }

      if (!skill) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found.",
          404,
        );
      }

      const installError = await options.skillsRepository
        .upsertInstallation({
          enabled: true,
          installedBy: user.id,
          skillId: body.skillId,
          workspaceId,
        })
        .then(() => null)
        .catch((error: unknown) => error);

      if (installError) {
        request.log.error({ err: installError }, "skill install failed");
        return sendSkillError(
          reply,
          "skill_install_failed",
          "Unable to install skill.",
        );
      }

      return reply.code(204).send();
    } catch (error) {
      request.log.error({ err: error }, "skill install error");
      return sendSkillError(
        reply,
        "skill_install_failed",
        "Unable to install skill.",
      );
    }
  });

  // DELETE /api/workspaces/skills/:skillId — uninstall a skill
  app.delete("/api/workspaces/skills/:skillId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { skillId } = request.params as { skillId: string };
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;
      let count: number;
      try {
        count = await options.skillsRepository.uninstall(workspaceId, skillId);
      } catch (error) {
        request.log.error({ err: error }, "skill uninstall failed");
        return sendSkillError(
          reply,
          "skill_uninstall_failed",
          "Unable to uninstall skill.",
        );
      }

      if (count === 0) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill is not installed in this workspace.",
          404,
        );
      }

      return reply.code(204).send();
    } catch (error) {
      request.log.error({ err: error }, "skill uninstall error");
      return sendSkillError(
        reply,
        "skill_uninstall_failed",
        "Unable to uninstall skill.",
      );
    }
  });

  // PATCH /api/workspaces/skills/:skillId — toggle enable/disable
  app.patch("/api/workspaces/skills/:skillId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { skillId } = request.params as { skillId: string };
      const payload = workspaceSkillToggleRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;
      // Verify skill exists in the catalog（可见性 = RLS 读策略等价物）
      let skill: { id: string } | null;
      try {
        skill = await options.skillsRepository.findVisibleSkill(
          user.id,
          skillId,
        );
      } catch {
        skill = null;
      }

      if (!skill) {
        return sendSkillError(
          reply,
          "skill_not_found",
          "Skill not found.",
          404,
        );
      }

      // Upsert: create workspace_skills row if not installed, or update enabled state
      const toggleError = await options.skillsRepository
        .upsertInstallation({
          enabled: payload.enabled,
          installedBy: user.id,
          skillId,
          workspaceId,
        })
        .then(() => null)
        .catch((error: unknown) => error);

      if (toggleError) {
        request.log.error({ err: toggleError }, "skill toggle failed");
        return sendSkillError(
          reply,
          "skill_toggle_failed",
          "Unable to toggle skill.",
        );
      }

      return reply.code(204).send();
    } catch (error) {
      if (isZodError(error)) {
        return reply.code(400).send({
          issues: error.issues,
          message: "Invalid request body",
        });
      }

      request.log.error({ err: error }, "skill toggle error");
      return sendSkillError(
        reply,
        "skill_toggle_failed",
        "Unable to toggle skill.",
      );
    }
  });
}

// ===========================================================================
// Helpers
// ===========================================================================

/** Shape of a row from the `skills` table. */
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
  // Added by 20260403100000_skill_files migration
  source_url?: string | null;
  package_name?: string | null;
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

/**
 * `skill_files` 行归一（repository 返回裸行，故入参为宽松形状，转换集中在此）。
 */
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

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

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

function sendSkillError(
  reply: FastifyReply,
  code: SkillErrorCode,
  message: string,
  statusCode = 500,
) {
  return reply.code(statusCode).send(
    applicationErrorResponseSchema.parse({
      error: { code, message },
    }),
  );
}

function isZodError(
  error: unknown,
): error is { issues: unknown[]; name: string } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
