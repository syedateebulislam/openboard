/**
 * Accept the current UI as the new baseline.
 *
 * A wrapper rather than `VAR=1 playwright test` in package.json, because that
 * form is a parse error in cmd.exe and this repo is developed on Windows.
 *
 * Accepting a baseline is deliberate: it says "this new look is correct". It is
 * kept as its own command so no ordinary run can do it by accident.
 */

import { spawn } from 'node:child_process';

const child = spawn(
  process.execPath,
  ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, OPENBOARD_UI_UPDATE_BASELINE: '1' },
  },
);

child.on('exit', (code) => process.exit(code ?? 1));
