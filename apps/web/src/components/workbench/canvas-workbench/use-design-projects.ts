"use client";

import type { ProjectSummary } from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveDesignAutoCanvas } from "@/lib/design-auto-canvas";
import {
  createProject,
  deleteProject,
  fetchProjects,
  updateProject,
} from "@/lib/server-api";

/** 保留 Design 的项目选择、创建和自动打开画布行为。 */
export function useDesignProjects(
  accessToken: string | null,
  mode: "design" | "flow",
) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const autoCanvasTried = useRef(false);
  const refreshProjects = useCallback(() => {
    if (!accessToken) return;
    fetchProjects(accessToken, "design")
      .then((data) => setProjects(data.projects))
      .catch(() => {})
      .finally(() => setProjectsLoaded(true));
  }, [accessToken]);
  useEffect(refreshProjects, [refreshProjects]);
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; projectId?: string } | null;
      if (data?.type === "workbench:project-created") {
        refreshProjects();
        if (data.projectId) setSelectedProjectId(data.projectId);
      }
      if (data?.type === "workbench:project-deleted") {
        setSelectedProjectId((current) =>
          current === data.projectId ? null : current,
        );
        refreshProjects();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [refreshProjects]);
  const createProjectNamed = useCallback(
    async (name: string): Promise<ProjectSummary | null> => {
      if (!accessToken) return null;
      setCreatingProject(true);
      try {
        const result = await createProject(accessToken, { name });
        setProjects((prev) => [result.project, ...prev]);
        return result.project;
      } catch {
        return null;
      } finally {
        setCreatingProject(false);
      }
    },
    [accessToken],
  );
  const renameProject = useCallback(
    async (projectId: string, name: string) => {
      if (!accessToken) return;
      try {
        await updateProject(accessToken, projectId, { name });
        setProjects((prev) =>
          prev.map((project) =>
            project.id === projectId ? { ...project, name } : project,
          ),
        );
      } catch {
        /* 保留旧名 */
      }
    },
    [accessToken],
  );
  const removeProject = useCallback(
    async (projectId: string) => {
      if (!accessToken) return;
      try {
        await deleteProject(accessToken, projectId);
      } catch {
        /* 保留原本的本地清理行为 */
      }
      setProjects((prev) => prev.filter((project) => project.id !== projectId));
      setSelectedProjectId((current) =>
        current === projectId ? null : current,
      );
      refreshProjects();
    },
    [accessToken, refreshProjects],
  );
  useEffect(() => {
    const decision = resolveDesignAutoCanvas({
      mode,
      activeTaskId: null,
      creatingProject,
      projectsLoaded,
      designProjectIds: projects.map((project) => project.id),
      selectedProjectId,
      autoCreateTried: autoCanvasTried.current,
    });
    if (decision.kind === "select") setSelectedProjectId(decision.projectId);
    if (decision.kind === "create") {
      autoCanvasTried.current = true;
      void createProjectNamed("未命名画布").then((project) => {
        if (project) setSelectedProjectId(project.id);
      });
    }
  }, [
    mode,
    creatingProject,
    projectsLoaded,
    projects,
    selectedProjectId,
    createProjectNamed,
  ]);
  return {
    projects,
    selectedProjectId,
    setSelectedProjectId,
    selectedProject:
      projects.find((project) => project.id === selectedProjectId) ?? null,
    creatingProject,
    createProjectNamed,
    renameProject,
    removeProject,
  };
}
