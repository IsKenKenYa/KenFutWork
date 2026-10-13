import type {
  ProjectDirectoryRelinkResponse,
  ProjectDirectoryRelinkSnapshot,
} from "@kenfutwork/shared";
import { useComposerAttachmentUploadStore } from "@zui/store/composerAttachmentUploadStore.js";
import type { TabStore } from "@zui/store/tabStore.js";
import { isWorkspaceTab } from "@zui/store/tabStore.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@zui/v4/composer/composerDraftStore.js";
import type { TaskWorkspaceRegistry } from "./taskWorkspaceRegistry.js";

function relocateAttachmentScopes(
  previousScopes: ReturnType<
    typeof useComposerAttachmentUploadStore.getState
  >["scopes"],
  scopeIds: string[],
  sourceKey: string,
  nextIdentity: string,
) {
  const scopes = { ...previousScopes };
  for (const scopeId of scopeIds) {
    const source = scopes[`${sourceKey}\u0000${scopeId}`];
    if (!source) continue;
    scopes[`${nextIdentity}\u0000${scopeId}`] = source.map((item) =>
      item.uploadStatus === "ready" || item.uploadStatus === "failed"
        ? item
        : {
            ...item,
            uploadStatus: "failed",
            uploadError: "目录授权已更新，请手动重试附件。",
            uploadErrorKind: "runtimeRestarted",
          },
    );
  }
  return scopes;
}
function relocateTabs(
  tabState: ReturnType<TabStore["getState"]>,
  snapshot: ProjectDirectoryRelinkSnapshot,
  receipt: ProjectDirectoryRelinkResponse,
  previousIdentity: string,
  nextIdentity: string,
  legacyMatches: boolean,
) {
  const matching = (path: string, identity?: string) =>
    path === snapshot.workDir &&
    (identity === previousIdentity || (!identity && legacyMatches));
  const expanded = new Set(tabState.expandedWorkspacePaths);
  if (expanded.has(snapshot.workDir)) {
    expanded.add(receipt.workDir);
    if (legacyMatches) expanded.delete(snapshot.workDir);
  }
  return {
    tabs: tabState.tabs.map((tab) =>
      isWorkspaceTab(tab) && matching(tab.workspacePath, tab.workspaceIdentity)
        ? {
            ...tab,
            workspacePath: receipt.workDir,
            workspaceIdentity: nextIdentity,
            availability: "available" as const,
          }
        : tab,
    ),
    activeWorkspacePath: matching(
      tabState.activeWorkspacePath ?? "",
      tabState.activeWorkspaceIdentity ?? undefined,
    )
      ? receipt.workDir
      : tabState.activeWorkspacePath,
    activeWorkspaceIdentity: matching(
      tabState.activeWorkspacePath ?? "",
      tabState.activeWorkspaceIdentity ?? undefined,
    )
      ? nextIdentity
      : tabState.activeWorkspaceIdentity,
    expandedWorkspacePaths: expanded,
  };
}

/** Consumes the validated POST receipt; it never sends text, uploads files, or restarts a Goal. */
export function applyDirectoryRelinkStores(
  registry: TaskWorkspaceRegistry,
  tabs: TabStore,
  snapshot: ProjectDirectoryRelinkSnapshot,
  receipt: ProjectDirectoryRelinkResponse,
) {
  const previousIdentity = JSON.stringify([
    snapshot.projectId,
    snapshot.workDir,
  ]);
  const nextIdentity = JSON.stringify([receipt.projectId, receipt.workDir]);
  const tabState = tabs.getState();
  const sessionState = useZCodeSessionStore.getState();
  const attachmentState = useComposerAttachmentUploadStore.getState();
  const legacySources = registry
    .knownWorkspaces()
    .filter((source) => source.rootDirectory === snapshot.workDir);
  const legacyMatches =
    legacySources.length === 1 &&
    legacySources[0]?.projectId === snapshot.projectId;
  const sourceKey = sessionState.workspaces[previousIdentity]
    ? previousIdentity
    : legacyMatches
      ? snapshot.workDir
      : previousIdentity;
  const sourceIdentity =
    sourceKey === previousIdentity ? previousIdentity : undefined;
  const previousBucket = sessionState.workspaces[sourceKey];
  const scopeIds = [V4_DRAFT_SCOPE_ROOT, ...receipt.affectedTaskIds];
  const drafts = scopeIds.map((scopeId) => ({
    scopeId,
    draft: readV4ComposerDraft(snapshot.workDir, sourceIdentity, scopeId),
    target: readV4ComposerDraft(receipt.workDir, nextIdentity, scopeId),
  }));
  // A pre-existing destination draft must not be silently overwritten; original input remains visible.
  if (
    drafts.some(
      ({ draft, target }) =>
        draft &&
        target &&
        JSON.stringify({ ...draft, updatedAt: 0 }) !==
          JSON.stringify({ ...target, updatedAt: 0 }),
    )
  )
    throw new Error("目录已关联，目标位置已有草稿；原草稿已保留。");
  let rollbackRegistry: (() => void) | undefined;
  const written: typeof drafts = [];
  try {
    rollbackRegistry = registry.applyDirectoryRelink(snapshot, receipt);
    for (const entry of drafts) {
      const { scopeId, draft } = entry;
      if (!draft) continue;
      const { updatedAt: _at, ...content } = draft;
      if (
        !persistV4ComposerDraft(receipt.workDir, nextIdentity, scopeId, content)
      )
        throw new Error("目录已关联，草稿保存失败；原草稿已保留。");
      written.push(entry);
    }
    if (previousBucket)
      useZCodeSessionStore.setState({
        workspaces: {
          ...sessionState.workspaces,
          [nextIdentity]: {
            ...previousBucket,
            draftSessionId: null,
            draftRuntime: { status: "idle", error: null },
            draftRuntimeInvalidationVersion:
              previousBucket.draftRuntimeInvalidationVersion + 1,
          },
        },
      });
    useComposerAttachmentUploadStore.setState({
      scopes: relocateAttachmentScopes(
        attachmentState.scopes,
        scopeIds,
        sourceKey,
        nextIdentity,
      ),
    });
    tabs.setState(
      relocateTabs(
        tabState,
        snapshot,
        receipt,
        previousIdentity,
        nextIdentity,
        legacyMatches,
      ),
    );
  } catch (error) {
    for (const { scopeId, target } of written) {
      if (target) {
        const { updatedAt: _at, ...content } = target;
        persistV4ComposerDraft(receipt.workDir, nextIdentity, scopeId, content);
      } else clearV4ComposerDraft(receipt.workDir, nextIdentity, scopeId);
    }
    useZCodeSessionStore.setState({ workspaces: sessionState.workspaces });
    useComposerAttachmentUploadStore.setState({
      scopes: attachmentState.scopes,
    });
    tabs.setState({
      tabs: tabState.tabs,
      activeWorkspacePath: tabState.activeWorkspacePath,
      activeWorkspaceIdentity: tabState.activeWorkspaceIdentity,
      expandedWorkspacePaths: tabState.expandedWorkspacePaths,
    });
    rollbackRegistry?.();
    throw error;
  }
}
