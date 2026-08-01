/**
 * Repoint registered boards at the folder the fetchers actually write to.
 *
 * Boards created before the biller scripts moved under ~/.openboard still list
 * dataFiles in the old external location, so a dashboard rebuild reads stale
 * CSVs while the fetchers append to new ones. This rewrites each dataFiles
 * entry to the canonical invoices directory, matching by filename and only
 * when the target actually exists.
 *
 * Dev helper; not shipped. Idempotent — safe to re-run.
 *
 * Usage: npx tsx scripts/dev/repoint-boards.mts [--apply]
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BoardRegistryService } from '../../src/services/project/BoardRegistryService.js';
import { TypedConfigRepository } from '../../src/services/config/TypedConfigRepository.js';
import { repoRootFor } from '../../src/services/billers/BillerDiscoveryService.js';

const apply = process.argv.includes('--apply');

const settings = new TypedConfigRepository().getBillerSettings();
if (!settings.scriptsDir) {
  console.log('No invoice scripts folder configured.');
  process.exit(1);
}

const invoicesDir = join(repoRootFor(settings.scriptsDir), 'data', 'invoices');
console.log(`canonical invoices dir: ${invoicesDir}`);
console.log(apply ? '(applying)\n' : '(dry run — pass --apply to write)\n');

const registry = new BoardRegistryService();
let changedCount = 0;

for (const board of registry.listBoards()) {
  const before = board.dataFiles ?? [];
  const after = before.map((path) => {
    // basename() handles both separators, so a Windows path recorded on one
    // machine still maps cleanly.
    const target = join(invoicesDir, basename(path.split(/[\\/]/).join('/')));
    return existsSync(target) ? target : path;
  });

  const changed = JSON.stringify(before) !== JSON.stringify(after);
  console.log(`${board.name.padEnd(20)} ${changed ? 'REPOINT' : 'unchanged'}`);

  if (!changed) continue;
  changedCount++;
  before.forEach((path, index) => {
    if (path !== after[index]) console.log(`    from ${path}\n      to ${after[index]}`);
  });

  if (apply) registry.upsertBoard({ ...board, dataFiles: after });
}

console.log(`\n${changedCount} board(s) ${apply ? 'repointed' : 'would be repointed'}.`);
