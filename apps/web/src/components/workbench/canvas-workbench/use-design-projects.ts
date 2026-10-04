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

type CanvasProject = Extract<ProjectSummary, { kind: "design" | "flow" }>;

/** 保留 Design 的项目选择、创建和自动打开画布行为。 */
export function useDesignProjects(
  accessToken: string | null,
  mode: "design" | "flow",
) {
  const [projects, setProjects] = useState<CanvasProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const autoCanvasTried = useRef(false);
  const refreshProjects = useCallback(() => {
    if (!accessToken) return;
    fetchProjects(accessToken, "design")
      .then((data) =>
        setProjects(
          data.projects.filter(
            (project): project is CanvasProject => project.kind !== "code",
          ),
        ),
      )
      .catch((error: unknown) =>
        setNotice(
          error instanceof Error ? error.message : "画布项目读取失败。",
        ),
      )
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
    async (name: string): Promise<CanvasProject | null> => {
      if (!accessToken) return null;
      setCreatingProject(true);
      try {
        const result = await createProject(accessToken, {
          kind: "design",
          name,
        });
        const project = result.project;
        if (project.kind === "code") throw new Error("画布项目类型不匹配。");
        setProjects((prev) => [project, ...prev]);
        setNotice(null);
        return project;
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "创建画布失败。");
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
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "重命名失败。");
      }
    },
    [accessToken],
  );
  const removeProject = useCallback(
    async (projectId: string) => {
      if (!accessToken) return;
      try {
        await deleteProject(accessToken, projectId);
        setProjects((prev) =>
          prev.filter((project) => project.id !== projectId),
        );
        setSelectedProjectId((current) =>
          current === projectId ? null : current,
        );
        refreshProjects();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "删除画布失败。");
      }
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
    notice,
  };
}
