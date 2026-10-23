import type { CreateProjectInput, IProjectService } from "@zcode/services";
import { useOptionalTabStore, useTabStoreApi } from "@zui/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { useEffect, useRef, useState } from "react";
import { ProjectEditor } from "./ProjectEditor.js";

export function ProjectCreation({
  workspacePath,
  workspaceIdentity,
  creation,
  service,
  onClose,
  onSaved,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  creation: Pick<CreateProjectInput, "creationId" | "kind">;
  service: IProjectService;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const tabs = useTabStoreApi();
  const activeTabId = useOptionalTabStore((state) => state.activeTabId);
  const originTabId = useRef(activeTabId);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const currentScope = useRef(workspaceKey);
  currentScope.current = workspaceKey;
  const activeTaskId = useZCodeSessionStore((state) =>
    state.getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId,
  );
  const draftFocusVersion = useZCodeSessionStore((state) =>
    state.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  const [originDraft] = useState(() => ({
    workspaceKey,
    activeTaskId,
    draftFocusVersion,
  }));
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const isCurrent = () => {
    const draft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    return (
      active.current &&
      tabs.getState().activeTabId === originTabId.current &&
      currentScope.current === originDraft.workspaceKey &&
      draft.activeTaskId === originDraft.activeTaskId &&
      draft.draftFocusVersion === originDraft.draftFocusVersion
    );
  };
  return (
    <ProjectEditor
      project={null}
      creation={creation}
      service={service}
      onClose={onClose}
      onSaved={async () => {
        if (isCurrent()) await onSaved();
      }}
      isCurrent={isCurrent}
      suspended={
        activeTabId !== originTabId.current ||
        workspaceKey !== originDraft.workspaceKey ||
        activeTaskId !== originDraft.activeTaskId ||
        draftFocusVersion !== originDraft.draftFocusVersion
      }
    />
  );
}
