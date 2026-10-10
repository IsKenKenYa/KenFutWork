"use client";

import type { ProjectSummary } from "@kenfutwork/shared";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
  frameRef: RefObject<HTMLIFrameElement | null>,
) {
  const [projects, setProjects] = useState<CanvasProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const autoCanvasTried = useRef(false);
  const readGeneration = useRef(0);
  const refreshProjects = useCallback(
    (selectId?: string) => {
      const generation = ++readGeneration.current;
      fetchProjects(accessToken, mode)
        .then((data) => {
          if (generation !== readGeneration.current) return;
          const visible = data.projects.filter(
            (project): project is CanvasProject => project.kind === mode,
          );
          setProjects(visible);
          if (selectId && visible.some((project) => project.id === selectId))
            setSelectedProjectId(selectId);
        })
        .catch((error: unknown) => {
          if (generation !== readGeneration.current) return;
          setNotice(
            error instanceof Error ? error.message : "画布项目读取失败。",
          );
        })
        .finally(() => {
          if (generation === readGeneration.current) setProjectsLoaded(true);
        });
    },
    [accessToken, mode],
  );
  useEffect(() => {
    refreshProjects();
    return () => {
      readGeneration.current++;
    };
  }, [refreshProjects]);
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const data = event.data as { type?: string; projectId?: string } | null;
      if (typeof data?.projectId !== "string" || !data.projectId) return;
      if (data?.type === "workbench:project-created") {
        // 由真实项目目录核对模式，不能把消息中的id直接当选中项目。
        refreshProjects(data.projectId);
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
  }, [refreshProjects, frameRef]);
  const createProjectNamed = useCallback(
    async (name: string): Promise<CanvasProject | null> => {
      setCreatingProject(true);
      try {
        const result = await createProject(accessToken, {
          kind: mode,
          name,
        });
        const project = result.project;
        if (project.kind !== mode) throw new Error("画布项目类型不匹配。");
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
    [accessToken, mode],
  );
  const renameProject = useCallback(
    async (projectId: string, name: string) => {
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
