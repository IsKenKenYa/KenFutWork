import type {
  CreateProjectInput,
  IProjectService,
  ProjectRootAccess,
  VirtualProject,
} from "@zcode/services";
import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { Input } from "@zui/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { DirectoryBrowser } from "@zui/DirectoryBrowser.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { getPathLeaf } from "@zui/lib/path.js";
import { logger } from "@zui/logger.js";
import { Folder, FolderPlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useProjectDirectoryServices } from "./useProjectDirectoryServices.js";
import {
  ProjectFolderTrustDialog,
  type ProjectFolderTrustRequest,
} from "./ProjectFolderTrustDialog.js";

const FIELD_LABEL = "text-ui-sm font-medium text-foreground";

export type ProjectCreationPreparation =
  | { kind: "reuse" }
  | { kind: "create"; directoryChoice?: "independent" }
  | null;

export type PrepareProjectCreation = (
  primaryRoot: string,
  signal: AbortSignal,
) => Promise<ProjectCreationPreparation>;

type EditorFlight = {
  controller: AbortController;
  settled: Promise<void>;
  cancelTrust?: () => void;
};

export function ProjectEditor({
  project,
  creation,
  onPrepareCreation,
  initialRoots = [],
  isCurrent = () => true,
  service,
  onClose,
  onSaved,
  onDeleted,
  suspended = false,
}: {
  isCurrent?(): boolean;
  service: IProjectService;
  onClose(): void;
  onSaved(project: VirtualProject): Promise<void>;
  onDeleted?(): Promise<void>;
  suspended?: boolean;
  initialRoots?: string[];
} & (
  | { project: VirtualProject; creation?: never; onPrepareCreation?: never }
  | {
      project: null;
      creation: Pick<CreateProjectInput, "creationId" | "kind">;
      onPrepareCreation: PrepareProjectCreation;
    }
)) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const [name, setName] = useState(project?.name ?? "");
  const [nameEdited, setNameEdited] = useState(false);
  const [roots, setRoots] = useState(
    project?.roots.map((root) => root.rootPath) ?? initialRoots,
  );
  const [primary, setPrimary] = useState(
    project?.roots.find((root) => root.isPrimary)?.rootPath ?? initialRoots[0] ?? "",
  );
  const [rootPermissions, setRootPermissions] = useState<
    Record<string, ProjectRootAccess>
  >(() =>
    Object.fromEntries(
      (project?.roots ?? []).flatMap((root) =>
        root.access ? [[root.rootPath, root.access]] : [],
      ),
    ),
  );
  const [browsing, setBrowsing] = useState(false);
  const directory = useProjectDirectoryServices(service);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<VirtualProject | null>(null);
  const [folderTrust, setFolderTrust] = useState<ProjectFolderTrustRequest | null>(null);
  const saveFlight = useRef<EditorFlight | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const epoch = useRef(0);
  const alive = useRef(true);
  const closing = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
      saveFlight.current?.controller.abort();
      saveFlight.current?.cancelTrust?.();
    };
  }, []);
  useEffect(() => {
    if (suspended) {
      epoch.current++;
      saveFlight.current?.controller.abort();
      saveFlight.current?.cancelTrust?.();
    }
  }, [suspended]);
  const current = (request: number) =>
    alive.current &&
    !closing.current &&
    epoch.current === request &&
    !suspendedRef.current &&
    isCurrent();
  const addRoots = (values: string[]) => {
    const next = [...new Set([...roots, ...values.filter(Boolean)])];
    setRoots(next);
    if (!roots.length) setPrimary(next[0] ?? "");
    setBrowsing(false);
  };
  const browse = () => {
    const select = platform?.selectDirectories?.bind(platform);
    if (select) {
      void startFlight((flight) => selectDirectories(flight, select));
      return;
    }
    epoch.current++;
    setBrowsing(true);
  };
  const startFlight = (operation: (flight: EditorFlight) => Promise<void>) => {
    if (closing.current || saveFlight.current || suspendedRef.current || !isCurrent()) return;
    const flight: EditorFlight = {
      controller: new AbortController(),
      settled: Promise.resolve(),
    };
    saveFlight.current = flight;
    flight.settled = operation(flight);
    return flight.settled;
  };
  const selectDirectories = async (
    flight: EditorFlight,
    select: () => Promise<string[]>,
  ) => {
    const request = ++epoch.current;
    const canCommit = () => current(request) && !flight.controller.signal.aborted;
    setBusy(true);
    setError(null);
    try {
      const selected = await select();
      logger.debug("[ProjectEditor] native directory selection", { count: selected.length });
      if (canCommit() && selected.length) addRoots(selected);
    } catch (cause) {
      logger.warn("[ProjectEditor] native directory selection failed", cause);
      if (canCommit()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (saveFlight.current === flight) saveFlight.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    epoch.current++;
    const flight = saveFlight.current;
    flight?.controller.abort();
    flight?.cancelTrust?.();
    await flight?.settled;
    if (alive.current) onClose();
  };
  const save = async (flight: EditorFlight) => {
    const request = epoch.current;
    const canCommit = () => current(request) && !flight.controller.signal.aborted;
    setBusy(true);
    setError(null);
    try {
      if (created) {
        await onSaved(created);
        if (canCommit()) onClose();
        return;
      }
      let directoryChoice: CreateProjectInput["directoryChoice"];
      if (!project) {
        const preparation = await onPrepareCreation(
          primary,
          flight.controller.signal,
        );
        if (!preparation || !canCommit()) return;
        if (preparation.kind === "reuse") {
          onClose();
          return;
        }
        directoryChoice = preparation.directoryChoice;
      }
      if (!project && roots.length) {
        const accepted = await new Promise<boolean>((resolve) => {
          const finish = (value: boolean) => {
            if (!flight.cancelTrust) return;
            flight.cancelTrust = undefined;
            if (alive.current) setFolderTrust(null);
            resolve(value);
          };
          flight.cancelTrust = () => finish(false);
          setFolderTrust({ roots: [...roots], resolve: finish });
        });
        if (!accepted || !canCommit()) return;
      }
      const saved = await service.saveProject({
        hostId: "local",
        ...(project
          ? { id: project.id, expectedRevision: project.revision }
          : creation),
        ...(directoryChoice ? { directoryChoice } : {}),
        ...(nameEdited ? { name: name.trim() } : {}),
        roots,
        ...(primary ? { primaryRoot: primary } : {}),
        rootPermissions: Object.fromEntries(
          roots.flatMap((root) => {
            const access = rootPermissions[root];
            return root !== primary && access ? [[root, access]] : [];
          }),
        ),
      });
      if (!alive.current) return;
      // 创建成功后刷新失败仍复用结果；重试不能再次创建项目。
      if (!project) setCreated(saved);
      if (!canCommit()) return;
      await onSaved(saved);
      if (canCommit()) onClose();
    } catch (cause) {
      if (canCommit())
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (saveFlight.current === flight) saveFlight.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const remove = async (flight: EditorFlight) => {
    const request = epoch.current;
    setBusy(true);
    setError(null);
    try {
      if (!project) return;
      await service.deleteProject(project.id, project.hostId);
      if (!current(request)) return;
      await onDeleted?.();
      if (current(request)) onClose();
    } catch (cause) {
      if (current(request))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (saveFlight.current === flight) saveFlight.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const browserEpoch = epoch.current;
  const missingPermission = roots.some(
    (root) => root !== primary && !rootPermissions[root],
  );
  return (
    <Dialog
      open={!suspended}
      onOpenChange={(open) => {
        if (!open) {
          logger.debug("[ProjectEditor] close requested", { busy });
          void close();
        }
      }}
    >
      <DialogContent className="max-w-lg gap-5">
        <DialogTitle>{browsing ? msg("browse") : project ? msg("edit") : msg("create")}</DialogTitle>
        <DialogDescription className="sr-only">
          {msg("description")}
        </DialogDescription>
        {browsing ? (
          <div
            className="flex h-96 min-h-0 flex-col gap-2"
            data-testid="virtual-project-directory-browser"
          >
            <DirectoryBrowser
              embedded
              showSelectionActions
              selectLabel={msg("browse")}
              services={directory.services}
              onSelect={(path) => {
                if (current(browserEpoch)) addRoots([path]);
              }}
              onCancel={() => {
                epoch.current++;
                setBrowsing(false);
              }}
            />
          </div>
        ) : (
          <>
            <div className="grid min-w-0 gap-1.5">
              <label htmlFor="project-name" className={FIELD_LABEL}>
                {msg("name")}
              </label>
              <Input
                id="project-name"
                aria-label={msg("name")}
                placeholder={msg("new")}
                autoFocus
                disabled={busy || Boolean(created)}
                data-testid="virtual-project-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameEdited(true);
                }}
                className="h-9 rounded-lg max-md:text-mobile-input-safe"
              />
            </div>
            <fieldset disabled={busy || Boolean(created)} className="min-w-0">
              <legend className={`mb-1.5 ${FIELD_LABEL}`}>
                {msg("folders")}
              </legend>
              <div
                data-testid={roots.length ? "virtual-project-roots" : undefined}
                className={
                  roots.length
                    ? "min-w-0 overflow-hidden rounded-lg border border-border divide-y divide-border"
                    : undefined
                }
              >
                {roots.map((root) => (
                  <div
                    className="flex min-h-12 min-w-0 items-center gap-2 px-3 py-2"
                    key={root}
                    data-testid="virtual-project-root-row"
                  >
                    <Folder className="size-4 shrink-0 text-foreground-subtle" />
                    <span
                      className="min-w-0 flex-1 truncate text-ui-base"
                      title={root}
                      data-testid="virtual-project-root-name"
                    >
                      {getPathLeaf(root)}
                    </span>
                    {root === primary ? (
                      <span
                        data-testid="virtual-project-primary"
                        className="inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2 text-ui-base text-foreground-subtle"
                      >
                        {msg("primaryBadge")}
                      </span>
                    ) : (
                      <>
                        {!project ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-foreground-subtle"
                            data-testid="virtual-project-set-primary"
                            onClick={() => setPrimary(root)}
                          >
                            {msg("setPrimary")}
                          </Button>
                        ) : null}
                        <Select
                          value={rootPermissions[root] ?? ""}
                          onValueChange={(access) => {
                            if (access !== "read-only" && access !== "read-write")
                              return;
                            setRootPermissions((previous) => ({
                              ...previous,
                              [root]: access,
                            }));
                          }}
                        >
                          <SelectTrigger
                            aria-label={msg("folderAccess")}
                            data-testid="virtual-project-root-access"
                            className="shrink-0"
                          >
                            <SelectValue placeholder={msg("chooseAccess")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="read-only">
                              {msg("readOnly")}
                            </SelectItem>
                            <SelectItem value="read-write">
                              {msg("readWrite")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </>
                    )}
                    {!project || root !== primary ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-foreground-subtle"
                        data-testid="virtual-project-remove-folder"
                        aria-label={msg("removeFolder")}
                        onClick={() => {
                          const next = roots.filter((item) => item !== root);
                          setRoots(next);
                          if (primary === root) setPrimary(next[0] ?? "");
                          setRootPermissions((previous) => {
                            const next = { ...previous };
                            delete next[root];
                            return next;
                          });
                        }}
                      >
                        <X className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                ))}
                <button
                  type="button"
                  data-testid="virtual-project-browse"
                  aria-label={msg("browse")}
                  className={`group flex w-full items-center gap-2 text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 ${roots.length ? "min-h-12 px-3 py-2 text-left" : "min-h-32 flex-col justify-center rounded-lg border border-dashed border-border px-4 py-5 text-center hover:border-border-hover"}`}
                  onClick={browse}
                >
                  {roots.length ? (
                    <>
                      <FolderPlus className="size-4 shrink-0 text-foreground-subtle" />
                      <span>{msg("addSourceFolder")}</span>
                    </>
                  ) : (
                    <>
                      <span className="flex size-9 items-center justify-center rounded-full bg-surface text-foreground-subtle group-hover:text-foreground">
                        <FolderPlus className="size-4" />
                      </span>
                      <span className="font-medium">{msg("browse")}</span>
                      <span className="text-ui-sm text-foreground-subtle">
                        {msg("browseHint")}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </fieldset>
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter className="flex-row flex-wrap items-center justify-end">
              {project && onDeleted ? (
                <Button
                  variant="ghost"
                  data-testid="virtual-project-editor-delete"
                  disabled={busy}
                  onClick={() => void startFlight(remove)}
                  className="mr-auto bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface hover:text-destructive-surface-foreground"
                >
                  {msg("archive")}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => void close()} disabled={busy}>
                {msg("cancel")}
              </Button>
              <Button
                ref={saveButton}
                data-testid="virtual-project-save"
                onClick={() => void startFlight(save)}
                disabled={busy || missingPermission || !roots.length || (nameEdited && !name.trim())}
              >
                {project ? msg("save") : msg("create")}
              </Button>
            </DialogFooter>
          </>
        )}
        {folderTrust && !suspended ? (
          <ProjectFolderTrustDialog
            request={folderTrust}
            onClosed={() => {
              if (alive.current && !closing.current && !suspendedRef.current) saveButton.current?.focus();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
