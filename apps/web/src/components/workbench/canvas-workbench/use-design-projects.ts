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
import { revealPath } from "@/lib/desktop-system";
import {
  ApiApplicationError,
  createProject,
  deleteProject,
  fetchDirectoryPickerStatus,
  fetchProjectDirectoryRelinkSnapshot,
  fetchProjects,
  pickDirectory,
  relinkProjectDirectory,
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
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const [relinkingProjectId, setRelinkingProjectId] = useState<string | null>(
    null,
  );
  const [relinkDraft, setRelinkDraft] = useState<{
    projectId: string;
    path: string;
  } | null>(null);
  const [directoryPickerAvailable, setDirectoryPickerAvailable] =
    useState(false);
  const [relinkableProjectId, setRelinkableProjectId] = useState<string | null>(
    null,
  );
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
    let current = true;
    fetchDirectoryPickerStatus(accessToken)
      .then(({ available }) => {
        if (current) setDirectoryPickerAvailable(available);
      })
      .catch(() => {
        if (current) setDirectoryPickerAvailable(false);
      });
    return () => {
      current = false;
    };
  }, [accessToken]);
  useEffect(() => {
    let current = true;
    const selected = projects.find(
      (project) => project.id === selectedProjectId,
    );
    setRelinkableProjectId(null);
    if (mode !== "design" || !selected?.workDir) return;
    void fetchProjectDirectoryRelinkSnapshot(accessToken, selected.id)
      .then((snapshot) => {
        if (current && snapshot.workDir === selected.workDir)
          setRelinkableProjectId(selected.id);
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (
          error instanceof ApiApplicationError &&
          error.message === "原项目目录仍存在，不能重新关联。"
        )
          return;
        setNotice(
          error instanceof Error ? error.message : "项目目录状态无法读取。",
        );
      });
    return () => {
      current = false;
    };
  }, [accessToken, mode, projects, selectedProjectId]);
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
    async (name: string, workDir?: string): Promise<CanvasProject | null> => {
      setCreatingProject(true);
      try {
        const result = await createProject(accessToken, {
          kind: mode,
          name,
          ...(workDir !== undefined ? { work_dir: workDir } : {}),
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
  const createProjectFromDirectory = useCallback(
    async (name: string): Promise<CanvasProject | null> => {
      setSelectingDirectory(true);
      try {
        const result = await pickDirectory(accessToken);
        if (result.status === "cancelled") return null;
        if (result.status !== "picked") {
          setNotice(result.reason);
          if (result.status === "unavailable")
            setDirectoryPickerAvailable(false);
          return null;
        }
        return await createProjectNamed(name, result.path);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "目录选择失败。");
        return null;
      } finally {
        setSelectingDirectory(false);
      }
    },
    [accessToken, createProjectNamed],
  );
  const relinkProjectDirectoryFromPicker = useCallback(
    async (projectId: string) => {
      if (mode !== "design") return;
      setRelinkingProjectId(projectId);
      setNotice(null);
      try {
        const snapshot = await fetchProjectDirectoryRelinkSnapshot(
          accessToken,
          projectId,
        );
        const picked = await pickDirectory(accessToken);
        if (picked.status === "cancelled") return;
        if (picked.status !== "picked") {
          setNotice(picked.reason);
          if (picked.status === "unavailable")
            setDirectoryPickerAvailable(false);
          return;
        }
        const nextWorkDir = picked.path;
        setRelinkDraft({ projectId, path: nextWorkDir });
        const result = await relinkProjectDirectory(accessToken, projectId, {
          expectedWorkDir: snapshot.workDir,
          nextWorkDir,
          expectedTasks: snapshot.tasks,
        });
        setRelinkDraft(null);
        setSelectedProjectId(projectId);
        refreshProjects(projectId);
        frameRef.current?.contentWindow?.postMessage(
          {
            type: "workbench:project-directory-relinked",
            projectId,
            tasks: result.tasks.map(({ taskId }) => taskId),
          },
          window.location.origin,
        );
      } catch (error) {
        setNotice(
          error instanceof Error ? error.message : "目录重新关联失败。",
        );
      } finally {
        setRelinkingProjectId(null);
      }
    },
    [accessToken, frameRef, mode, refreshProjects],
  );
  const openProjectDirectory = useCallback(async (path: string) => {
    try {
      await revealPath(path);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法打开工作目录。");
    }
  }, []);
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
    selectingDirectory,
    relinkingProjectId,
    relinkDraft,
    directoryPickerAvailable,
    relinkableProjectId,
    createProjectNamed,
    createProjectFromDirectory,
    relinkProjectDirectoryFromPicker,
    openProjectDirectory,
    renameProject,
    removeProject,
    notice,
  };
}
