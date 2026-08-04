/**
 * Stop the preview server and turn the run into a report.
 *
 * The server is stopped by pid read back from the session file: teardown runs
 * after the workers, and the handle from globalSetup is not guaranteed to still
 * be in scope. Killing a pid we started ourselves is bounded and specific — no
 * process-name matching, nothing else on the machine is touched.
 */

import { existsSync, readFileSync } from 'node:fs';
import { SESSION_FILE } from './global-setup.js';
import { writeReport, UI_OUT } from './report.js';

export default async function globalTeardown(): Promise<void> {
  if (existsSync(SESSION_FILE)) {
    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as { pid?: number };
    if (session.pid) {
      try {
        process.kill(session.pid);
      } catch {
        // Already gone — the run ended it, or Vite exited on its own.
      }
    }
  }

  const { records, errors, warnings } = writeReport();
  // eslint-disable-next-line no-console
  console.log(
    `\nUI report → ${UI_OUT}\\ui-report.md` +
      `\n  ${records.length} screen(s) · ${errors} error(s) · ${warnings} warning(s)\n`,
  );
}
