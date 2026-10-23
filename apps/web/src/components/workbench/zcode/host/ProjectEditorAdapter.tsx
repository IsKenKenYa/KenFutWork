import type { IProjectService, VirtualProject } from "@zcode/services";
import { parseLocalWorkspaceIdentity } from "@zcode/shared";
import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { ProjectEditor } from "@zui/project-sidebar/ProjectEditor.js";
import { useTabStoreApi } from "@zui/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@zui/store/tabStore.js";
import { useEffect, useRef, useState } from "react";

export function ProjectEditorAdapter({
  projectId,
  service,
  refreshProjects,
  onClose,
}: {
  projectId: string;
  service: IProjectService;
  refreshProjects(): Promise<void>;
  onClose(): void;
}) {
  const { intl } = useZCodeIntl();
  const tabs = useTabStoreApi();
  const [project, setProject] = useState<VirtualProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setProject(null);
    setError(null);
    void service
      .readProjects({ hostId: "local" })
      .then((projects) => {
        if (!current) return;
        const target = projects.find((item) => item.id === projectId);
        if (!target) throw new Error("项目已不可用，请重新选择项目。");
        setProject(target);
      })
      .catch((cause: unknown) => {
        if (current)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      current = false;
    };
  }, [projectId, reload, service]);
  if (project)
    return (
      <ProjectEditor
        key={project.id}
        project={project}
        service={service}
        isCurrent={() => alive.current}
        onClose={onClose}
        onSaved={refreshProjects}
        onDeleted={async () => {
          await refreshProjects();
          if (!alive.current) return;
          for (const tab of tabs.getState().tabs) {
            if (
              isWorkspaceTab(tab) &&
              parseLocalWorkspaceIdentity(
                tab.workspaceIdentity ?? "",
                tab.workspacePath,
              )?.projectId === projectId
            )
              tabs.getState().closeTab(tab.id);
          }
        }}
      />
    );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg gap-5">
        <DialogTitle>{intl.formatMessage({ id: "project.edit" })}</DialogTitle>
        <DialogDescription className="sr-only">
          {intl.formatMessage({ id: "project.description" })}
        </DialogDescription>
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : (
          <p role="status" className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          {error ? (
            <Button onClick={() => setReload((value) => value + 1)}>
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
