import type { ProjectSummary } from "@kenfutwork/shared";
import { surfaceJson } from "./surfaceApi.js";

const PROJECT_KINDS = ["flow", "code", "design", "work"] as const;

/** 全部工作方式的项目清单（按 id 去重）；项目归属由服务端一处持有，客户端只读。 */
export async function listAllProjects(): Promise<ProjectSummary[]> {
  const lists = await Promise.all(
    PROJECT_KINDS.map((kind) =>
      surfaceJson<{ projects: ProjectSummary[] }>(`/api/projects?kind=${kind}`),
    ),
  );
  const seen = new Set<string>();
  return lists
    .flatMap((list) => list.projects)
    .filter((project) => {
      if (seen.has(project.id)) return false;
      seen.add(project.id);
      return true;
    });
}
