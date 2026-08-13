import type { ComponentChildren } from 'preact';

/**
 * The handful of Lucide icons Dolly uses, copied verbatim rather than pulling in
 * the package. Lucide is ISC-licensed. Icons are 24×24 on a 2px stroke; keep the
 * originals' geometry when adding more.
 */

export type IconProps = {
  size?: number;
  strokeWidth?: number;
  class?: string;
};

function Glyph({
  size = 16,
  strokeWidth = 2,
  class: className,
  children,
}: IconProps & { children: ComponentChildren }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** lucide `play`, filled — an outline triangle reads poorly at button sizes. */
export function PlayIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <polygon points="6 3 20 12 6 21 6 3" fill="currentColor" />
    </Glyph>
  );
}

/** lucide `square`, filled — the stop counterpart to play. */
export function StopIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" />
    </Glyph>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m6 9 6 6 6-6" />
    </Glyph>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Glyph>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 12h14" />
    </Glyph>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Glyph>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </Glyph>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11" />
    </Glyph>
  );
}

export function RedoIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13" />
    </Glyph>
  );
}
