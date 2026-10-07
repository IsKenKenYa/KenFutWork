import { type WindowTabState } from "@zui/store/tabStore.js";

export function shouldPublishCompleteWorkspaceSnapshot(
  hasCompletedFullTabRestore: boolean,
): boolean {
  return hasCompletedFullTabRestore;
}
