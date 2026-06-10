/**
 * ProjectLockService — per-project-directory lockfile so concurrent OpenBoard
 * runs (e.g. a cron `update --all` overlapping a manual TUI deploy) don't
 * mutate the same generated workspace at once.
 *
 * Lock = `<projectDir>/.openboard.lock` containing { pid, createdAt }.
 * A lock is stale when its process is gone or it is older than 30 minutes.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FILE = '.openboard.lock';
const STALE_AFTER_MS = 30 * 60 * 1000;

export interface LockHandle {
  success: boolean;
  error?: string;
  release: () => void;
}

interface LockPayload {
  pid: number;
  createdAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ProjectLockService {
  static acquire(projectDir: string): LockHandle {
    const lockPath = join(projectDir, LOCK_FILE);

    if (existsSync(lockPath)) {
      const existing = ProjectLockService.readLock(lockPath);
      const stale =
        !existing ||
        !isProcessAlive(existing.pid) ||
        Date.now() - new Date(existing.createdAt).getTime() > STALE_AFTER_MS;

      if (!stale) {
        return {
          success: false,
          error: `Project is locked by another OpenBoard run (pid ${existing!.pid}, since ${existing!.createdAt}). Retry after it finishes.`,
          release: () => {},
        };
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // fall through; write below will overwrite
      }
    }

    const payload: LockPayload = { pid: process.pid, createdAt: new Date().toISOString() };
    try {
      writeFileSync(lockPath, JSON.stringify(payload), { flag: 'w' });
    } catch (err: any) {
      return { success: false, error: `Could not acquire project lock: ${err.message}`, release: () => {} };
    }

    let released = false;
    return {
      success: true,
      release: () => {
        if (released) return;
        released = true;
        try {
          // Only remove our own lock.
          const current = ProjectLockService.readLock(lockPath);
          if (current?.pid === process.pid) unlinkSync(lockPath);
        } catch {
          // best-effort
        }
      },
    };
  }

  private static readLock(lockPath: string): LockPayload | undefined {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockPayload;
      return typeof parsed.pid === 'number' && typeof parsed.createdAt === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

export default ProjectLockService;
