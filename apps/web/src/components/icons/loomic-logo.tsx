import type { SVGProps } from "react";

/**
 * KenFutWork brand mark — rounded square with a bold "K".
 *
 * Uses `currentColor` for the square so the icon automatically adapts to
 * light / dark themes. The K stroke is always the opposite colour.
 *
 * @example
 * <LoomicLogo className="size-7 text-foreground" />
 */
export function LoomicLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Rounded square */}
      <rect width="100" height="100" rx="24" fill="currentColor" />
      {/* K glyph */}
      <path
        d="M34 26 L34 74 M68 26 L46 50 L68 74"
        className="stroke-white dark:stroke-black"
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
