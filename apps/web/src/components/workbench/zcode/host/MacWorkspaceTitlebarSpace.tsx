export function MacWorkspaceTitlebarSpace({
  reserveOverlay = false,
  fullscreen = false,
}: {
  reserveOverlay?: boolean;
  fullscreen?: boolean;
}) {
  if (fullscreen) return null;
  return (
    <div
      aria-hidden="true"
      className={
        reserveOverlay
          ? "h-13 w-full shrink-0 [app-region:drag]"
          : "h-1 w-full shrink-0 [app-region:drag]"
      }
    />
  );
}
