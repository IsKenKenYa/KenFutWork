"use client";

/**
 * Full-screen loading screen with animated KenFutWork mark.
 * - K square: gentle float + breathing
 * - Loading dots below
 */
export function LoadingScreen() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-5">
        <div className="animate-logo-float">
          <svg
            viewBox="0 0 100 100"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="size-14 text-foreground"
          >
            <rect width="100" height="100" rx="24" fill="currentColor" />
            <path
              d="M34 26 L34 74 M68 26 L46 50 L68 74"
              className="stroke-white dark:stroke-black"
              strokeWidth="11"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </div>
        <div className="flex items-center gap-1">
          <span className="h-1 w-1 rounded-full bg-foreground/30 animate-loading-dot [animation-delay:0ms]" />
          <span className="h-1 w-1 rounded-full bg-foreground/30 animate-loading-dot [animation-delay:160ms]" />
          <span className="h-1 w-1 rounded-full bg-foreground/30 animate-loading-dot [animation-delay:320ms]" />
        </div>
      </div>
    </div>
  );
}
