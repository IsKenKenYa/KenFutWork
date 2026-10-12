import type {
  ProjectDirectoryRelinkResponse,
  ProjectDirectoryRelinkSnapshot,
} from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import { DirectoryBrowser } from "@zui/DirectoryBrowser.js";
import { useTabStore, useTabStoreApi } from "@zui/store/TabStoreProvider.js";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { applyDirectoryRelinkStores } from "./directoryRelinkStores.js";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";
import { ProjectDirectoryRecoveryDialog } from "./ProjectDirectoryRecoveryDialog.js";

const ClientContext = createContext<CodeHttpChannelClient | null>(null);
export function CodeDirectoryRecoveryProvider({
  client,
  children,
}: {
  client: CodeHttpChannelClient;
  children: ReactNode;
}) {
  return (
    <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
  );
}
/** Mounted by the first-party sidebar host inside the original Root's real stores. */
export function ProjectDirectoryRecovery() {
  const client = useContext(ClientContext);
  return client ? <ConnectedDirectoryRecovery client={client} /> : null;
}

function useDirectoryRecovery(client: CodeHttpChannelClient) {
  const tabs = useTabStoreApi();
  const path = useTabStore((state) => state.activeWorkspacePath);
  const identity = useTabStore((state) => state.activeWorkspaceIdentity);
  const [snapshot, setSnapshot] =
    useState<ProjectDirectoryRelinkSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingReceipt, setPendingReceipt] = useState<{
    snapshot: ProjectDirectoryRelinkSnapshot;
    receipt: ProjectDirectoryRelinkResponse;
    applied?: boolean;
  } | null>(null);
  useEffect(() => {
    let current = true;
    setSnapshot(null);
    setError(null);
    const project = path ? client.projectForPath(path, identity) : null;
    if (project)
      void client
        .directoryRelinkSnapshot(project.projectId)
        .then((view) => {
          if (current) setSnapshot(view);
        })
        .catch((failure: unknown) => {
          if (current)
            setError(
              failure instanceof Error
                ? failure.message
                : "项目目录状态无法读取。",
            );
        });
    return () => {
      current = false;
    };
  }, [client, path, identity]);
  const applyReceipt = async (
    view: ProjectDirectoryRelinkSnapshot,
    receipt: ProjectDirectoryRelinkResponse,
    applied = false,
  ) => {
    if (!applied)
      applyDirectoryRelinkStores(client.workspaces, tabs, view, receipt);
    setPendingReceipt({ snapshot: view, receipt, applied: true });
    await client.refreshWorkspaces();
    setPendingReceipt(null);
    setOpen(false);
    setSnapshot(null);
  };
  const selected = async (nextPath: string) => {
    if (!snapshot || busy) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await client.relinkDirectory(snapshot, nextPath);
      setPendingReceipt({ snapshot, receipt });
      await applyReceipt(snapshot, receipt);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "项目目录关联失败，请刷新后重试。",
      );
    } finally {
      setBusy(false);
    }
  };
  const retryBinding = () => {
    if (!pendingReceipt || busy) return;
    const result = pendingReceipt;
    setBusy(true);
    void applyReceipt(result.snapshot, result.receipt, result.applied)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "绑定刷新失败。"),
      )
      .finally(() => setBusy(false));
  };
  return {
    snapshot,
    pendingReceipt,
    error,
    open,
    busy,
    setOpen,
    selected,
    retryBinding,
  };
}
function ConnectedDirectoryRecovery({
  client,
}: {
  client: CodeHttpChannelClient;
}) {
  const {
    snapshot,
    pendingReceipt,
    error,
    open,
    busy,
    setOpen,
    selected,
    retryBinding,
  } = useDirectoryRecovery(client);
  if (!snapshot && !pendingReceipt && !error) return null;
  return (
    <div className="px-3 pb-2">
      {snapshot && !pendingReceipt ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          重新关联
        </Button>
      ) : null}
      {error && !open ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {pendingReceipt ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={retryBinding}
        >
          刷新绑定
        </Button>
      ) : null}
      <ProjectDirectoryRecoveryDialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
        busy={busy}
        error={error}
      >
        <DirectoryBrowser
          services={client.directoryServices()}
          onCancel={() => setOpen(false)}
          onSelect={(value) => {
            void selected(value);
          }}
        />
      </ProjectDirectoryRecoveryDialog>
    </div>
  );
}
