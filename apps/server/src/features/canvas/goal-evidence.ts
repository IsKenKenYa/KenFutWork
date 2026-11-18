import { createHash } from "node:crypto";
import { z } from "zod";
import type { GoalToolEvidenceValidator } from "../goals/consumer.js";
import type { CanvasService } from "./canvas-service.js";
import type { CanvasDocumentAccess } from "./document-access.js";

const version = z.string().regex(/^[a-f0-9]{64}$/u);
const creationReceipt = z.object({
  success: z.literal(true),
  applied: z.number().int().positive(),
  canvasId: z.uuid(),
  revision: version,
  createdElements: z.array(z.object({ id: z.string().min(1), version })).min(1),
});

/** Full persisted element content is versioned; Excalidraw's numeric version alone is insufficient. */
export function canvasElementVersion(element: Record<string, unknown>): string {
  const normalized = JSON.stringify(element, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  return createHash("sha256").update(normalized).digest("hex");
}

function receipt(outputText: string) {
  try {
    return creationReceipt.safeParse(JSON.parse(outputText));
  } catch {
    return null;
  }
}

/** The caller supplies the current VerifyGoal Task/Run, never the historical creation Run. */
export function createCanvasGoalToolEvidenceValidator(deps: {
  canvas: Pick<CanvasService, "readCanvasContent">;
  access: Pick<CanvasDocumentAccess, "authorize">;
}): GoalToolEvidenceValidator {
  return {
    accepts: (outputText) => receipt(outputText)?.success === true,
    async validate(context, evidence) {
      const parsed = receipt(evidence.detail ?? "");
      if (!parsed?.success)
        throw new Error("画布成果缺少版本证明，请重新核验。");
      const proof = parsed.data;
      const authorize = () =>
        deps.access.authorize(context, proof.canvasId, "read");
      const guard = async () => {
        await authorize();
      };
      context.signal?.throwIfAborted();
      const actor = await authorize();
      const content = await deps.canvas.readCanvasContent(
        actor,
        proof.canvasId,
        guard,
      );
      await authorize();
      context.signal?.throwIfAborted();
      for (const created of proof.createdElements) {
        const current = content.elements.find(
          (element) => element.id === created.id,
        );
        if (
          !current ||
          current.isDeleted ||
          canvasElementVersion(current) !== created.version
        )
          throw new Error("画布成果已删除或变化，请重新核验。");
      }
    },
  };
}
