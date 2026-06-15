/**
 * Single source of truth for the OpenBoard version.
 *
 * Read straight from package.json so the banner (TUI welcome screen and the
 * `--version` flag) can never drift from the published package version again.
 * tsup/esbuild inlines this JSON at build time.
 */
import pkg from '../package.json';

export const VERSION: string = pkg.version;

/** Inner width of the ASCII banner box (between the ║ borders). */
export const BANNER_INNER_WIDTH = 39;

/**
 * Center `v<version>` inside the banner's inner width so the version line
 * lines up with the rest of the box regardless of how long the version is.
 */
export function bannerVersionLine(version: string = VERSION): string {
  const label = `v${version}`;
  const totalPad = Math.max(0, BANNER_INNER_WIDTH - label.length);
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return ' '.repeat(left) + label + ' '.repeat(right);
}
