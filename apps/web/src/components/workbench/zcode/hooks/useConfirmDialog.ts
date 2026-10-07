import { useConfirmDialogStore } from "@zui/store/confirmDialogStore.js";

export function useConfirmDialog() {
  return useConfirmDialogStore((state) => state.requestConfirmation);
}
