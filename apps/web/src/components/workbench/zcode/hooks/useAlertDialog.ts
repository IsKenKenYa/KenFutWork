import { useAlertDialogStore } from "@zui/store/alertDialogStore.js";

export function useAlertDialog() {
  return useAlertDialogStore((state) => state.requestAlert);
}
