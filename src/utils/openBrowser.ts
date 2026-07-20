import { spawn } from 'node:child_process';

/**
 * Best-effort cross-platform browser launch. Failure is non-fatal — callers
 * always print the URL as a copy/paste fallback, so a headless or sandboxed
 * environment just means the user opens the link manually.
 */
export function openBrowser(url: string): void {
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
