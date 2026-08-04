/**
 * ProjectLockService — per-project-directory lockfile so concurrent OpenBoard
 * runs (e.g. a cron `update --all` overlapping a manual TUI deploy) don't
 * mutate the same generated workspace at once.
 *
 * Lock = `<projectDir>/.openboard.lock` containing { pid, createdAt }.
 *
 * A lock is stale — and so reclaimable — when its process is gone, when it is
 * older than 30 minutes, or when it carries our own pid without a live handle
 * in this process backing it.
 *
 * Note the limit of a pid: it identifies a process, not *which* process. An
 * operating system recycles pids freely, so a lock left by a crashed run can
 * read as alive until the 30-minute window expires. That is why the failure
 * message names the lockfile — a user with no other run active can delete it.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FILE = '.openboard.lock';
const STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Lock paths this process is holding right now.
 *
 * The lockfile records a pid, which cannot tell "I am still using this" from "I
 * crashed and left the file behind" — both look like our pid. This set is the
 * missing half: present means a live handle owns it, absent means the file is
 * ours but leaked and can be reclaimed.
 */
const HELD = new Set<string>();

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

/**
 * Drop whatever this process still holds when it exits.
 *
 * Without this, quitting mid-deploy strands the lockfile. On the next launch
 * the pid no longer belongs to us, so the in-process check cannot help, and if
 * the OS has recycled that pid the lock reads as alive until it ages out.
 * Registered once, synchronous because `exit` handlers cannot await.
 */
let cleanupRegistered = false;
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on('exit', () => {
    for (const lockPath of HELD) {
      try {
        const current = ProjectLockService.readOwnedLock(lockPath);
        if (current) unlinkSync(lockPath);
      } catch {
        // best-effort: the process is going away regardless
      }
    }
    HELD.clear();
  });
}

export class ProjectLockService {
  static acquire(projectDir: string): LockHandle {
    const lockPath = join(projectDir, LOCK_FILE);
    const payload: LockPayload = { pid: process.pid, createdAt: new Date().toISOString() };
    let acquired = false;

    // `wx` is the lock: creation succeeds for exactly one contender. A stale
    // lock is removed and creation is attempted once more.
    for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
      try {
        writeFileSync(lockPath, JSON.stringify(payload), { flag: 'wx' });
        acquired = true;
      } catch (error: unknown) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') {
          return { success: false, error: `Could not acquire project lock: ${err.message}`, release: () => {} };
        }
        const existing = ProjectLockService.readLock(lockPath);

        // A lock carrying our own pid needs care. If this process is genuinely
        // holding it — the biller scheduler can fire while the TUI is mid
        // refresh — blocking is the whole point of the lock. But if no handle
        // in this process holds it, the file leaked from an operation that
        // ended without releasing, and it would otherwise block every later
        // operation in the session while naming the very process reading it.
        if (existing?.pid === process.pid && HELD.has(lockPath)) {
          return {
            success: false,
            error: 'Another OpenBoard operation is already working on this project. Wait for it to finish.',
            release: () => {},
          };
        }
        const leakedByUs = existing?.pid === process.pid;

        const stale = !existing || leakedByUs || !isProcessAlive(existing.pid) ||
          Date.now() - new Date(existing.createdAt).getTime() > STALE_AFTER_MS;
        if (!stale) {
          return {
            success: false,
            // The path matters: pids get recycled, so a lock left by a crashed
            // run can look alive for the full staleness window. Without it the
            // user has no way out but to wait.
            error: `Project is locked by another OpenBoard run (pid ${existing!.pid}, since ${existing!.createdAt}). ` +
              `Retry after it finishes, or delete ${lockPath} if no other run is active.`,
            release: () => {},
          };
        }
        try {
          unlinkSync(lockPath);
        } catch (unlinkError: unknown) {
          const message = unlinkError instanceof Error ? unlinkError.message : String(unlinkError);
          return { success: false, error: `Could not remove stale project lock: ${message}`, release: () => {} };
        }
      }
    }
    if (!acquired) {
      return { success: false, error: 'Could not acquire project lock after removing a stale lock.', release: () => {} };
    }

    HELD.add(lockPath);
    registerCleanup();

    let released = false;
    return {
      success: true,
      release: () => {
        if (released) return;
        released = true;
        HELD.delete(lockPath);
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

  /** The lock at this path if it is ours, so exit cleanup never takes another run's. */
  static readOwnedLock(lockPath: string): LockPayload | undefined {
    const current = ProjectLockService.readLock(lockPath);
    return current?.pid === process.pid ? current : undefined;
  }
}

export default ProjectLockService;
