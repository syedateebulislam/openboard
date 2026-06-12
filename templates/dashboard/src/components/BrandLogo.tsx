/**
 * OpenBoard brand mark — the [_-_] bracket logo from openboard-site.
 * Theme-aware (uses CSS variables) so it renders in dark and light mode.
 * Must stay in the master shell header on every dashboard update.
 */
export function BrandLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="OpenBoard logo"
    >
      <rect width="32" height="32" rx="6" fill="var(--bg-elevated)" stroke="var(--border-subtle)" strokeWidth="1" />
      <g fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 8 H6.5 V24 H9" />
        <line x1="9.8" y1="21" x2="13" y2="21" />
        <line x1="13.5" y1="16" x2="18.5" y2="16" />
        <line x1="19" y1="21" x2="22.2" y2="21" />
        <path d="M23 8 H25.5 V24 H23" />
      </g>
    </svg>
  );
}
