export function MacWorkspaceTitlebarSpace({
  hasHeader = false,
  fullscreen = false,
}: {
  hasHeader?: boolean;
  fullscreen?: boolean;
}) {
  if (fullscreen) return null;
  return (
    <div
      aria-hidden="true"
      className={
        hasHeader
          ? "h-1 w-full shrink-0 [app-region:drag]"
          : "h-[var(--workspace-mac-titlebar-height)] w-full shrink-0 select-none [app-region:drag]"
      }
    />
  );
}
