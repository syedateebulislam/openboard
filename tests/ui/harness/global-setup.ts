/**
 * Start the generated app once for the whole run and publish how to reach it.
 *
 * The credentials are minted here and handed to the specs through a file rather
 * than the environment, because Playwright's globalSetup runs in a different
 * process from the workers — an env var set here would not reach them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveWorkspace, dashboardTabs } from './workspace.js';
import { resetReport, UI_OUT } from './report.js';

export const SESSION_FILE = join(import.meta.dirname, '..', '.artifacts', 'session.json');

export default async function globalSetup(): Promise<void> {
  mkdirSync(UI_OUT, { recursive: true });
  mkdirSync(join(import.meta.dirname, '..', '.artifacts'), { recursive: true });
  resetReport();

  const app = await serveWorkspace(Number(process.env.OPENBOARD_UI_PORT ?? 5199));
  const tabs = dashboardTabs(app.workspace);

  // eslint-disable-next-line no-console
  console.log(`\nUI suite → ${app.workspace}\n  ${app.baseURL} · ${tabs.length} dashboard tab(s)\n`);

  writeFileSync(
    SESSION_FILE,
    JSON.stringify(
      { baseURL: app.baseURL, username: app.username, password: app.password, workspace: app.workspace, pid: app.pid, tabs },
      null,
      2,
    ),
    'utf-8',
  );
}
