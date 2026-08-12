import { spawn } from 'node:child_process';

/**
 * Is this a URL we are willing to hand to the OS?
 *
 * The Windows branch below goes through `cmd /c start`, and cmd re-parses its
 * command line, so a URL carrying `&` or `^` could escape into a second
 * command. Two independent checks: the scheme must be http(s) — which rules
 * out `file:`, `javascript:` and the shell handlers registered for arbitrary
 * schemes — and the string must carry no cmd metacharacter.
 *
 * URLs reaching here come from Vercel API responses and the local preview
 * server rather than an attacker, so this is defence in depth. It costs one
 * parse and removes the question.
 */
export function isSafeBrowserUrl(url: string): boolean {
  if (/[&|<>^"%\r\n]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Best-effort cross-platform browser launch. Failure is non-fatal — callers
 * always print the URL as a copy/paste fallback, so a headless or sandboxed
 * environment just means the user opens the link manually.
 */
export function openBrowser(url: string): void {
  // Refusing is safe: every caller prints the URL too, so the user still has
  // a working path to it.
  if (!isSafeBrowserUrl(url)) return;

  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* fall back to the printed URL */ });
    child.unref();
  } catch {
    // Fall back to the printed URL.
  }
}
