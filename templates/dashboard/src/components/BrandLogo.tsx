/**
 * OpenBoardCLI brand mark — the [>_] bracket logo: a prompt caret and cursor
 * framed by brackets, for "board" and "CLI" in one mark.
 *
 * Theme-aware (uses CSS variables) so it renders in dark and light mode.
 * Must stay in the master shell header on every dashboard update.
 *
 * The same five path commands are duplicated in public/favicon.svg with
 * hardcoded colours (a favicon cannot read CSS variables). Nothing tests that
 * the two agree — change them together.
 */
export function BrandLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="OpenBoardCLI logo"
    >
      <rect width="32" height="32" rx="6" fill="var(--bg-elevated)" stroke="var(--border-subtle)" strokeWidth="1" />
      <g fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 8 H6.5 V24 H9" />
        <path d="M12 12.5 L16 16 L12 19.5" />
        <line x1="18" y1="19.5" x2="21" y2="19.5" />
        <path d="M23 8 H25.5 V24 H23" />
      </g>
    </svg>
  );
}
