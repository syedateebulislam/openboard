/**
 * RunStateService — persistent per-run state under ~/.openboard/runs/.
 *
 * One JSON file per pipeline run. Powers:
 *  - `openboard agent resume <run-id>` (continue from the failed phase)
 *  - idempotency keys (`agent create --idempotency-key`)
 *  - run history + typical phase durations (/doctor, progress ETAs)
 *  - token accounting per run
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PipelinePhase } from './pipelinePhases.js';

export type RunAction = 'create' | 'update' | 'refresh' | 'remove' | 'rollback';
export type RunStatus = 'running' | 'failed' | 'succeeded';

export interface RunPhaseRecord {
  completedAt: string;
  durationMs: number;
}

export interface RunTokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** True when counts are chars/4 estimates rather than provider-reported. */
  estimated: boolean;
}

export interface RunRecord {
  runId: string;
  action: RunAction;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  /** Original options, replayable on resume. */
  options: Record<string, unknown>;
  idempotencyKey?: string;
  boardId?: string;
  boardName?: string;
  boardTitle?: string;
  projectDir?: string;
  currentPhase?: PipelinePhase;
  phases: Partial<Record<PipelinePhase, RunPhaseRecord>>;
  writtenFiles?: string[];
  deployUrl?: string;
  error?: string;
  errorCode?: string;
  tokenUsage?: RunTokenUsage;
}

const MAX_RUNS_KEPT = 100;

export class RunStateService {
  private runsDir: string;

  constructor(configDir?: string) {
    const root = configDir
      ?? process.env.OPENBOARD_CONFIG_DIR
      ?? join(homedir(), '.openboard');
    this.runsDir = join(root, 'runs');
  }

  createRun(action: RunAction, options: Record<string, unknown>, idempotencyKey?: string): RunRecord {
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: `run-${now.slice(0, 10)}-${randomUUID().slice(0, 8)}`,
      action,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      options,
      idempotencyKey,
      phases: {},
    };
    this.save(record);
    this.prune();
    return record;
  }

  save(record: RunRecord): void {
    record.updatedAt = new Date().toISOString();
    try {
      if (!existsSync(this.runsDir)) mkdirSync(this.runsDir, { recursive: true });
      writeFileSync(this.runPath(record.runId), JSON.stringify(record, null, 2), 'utf-8');
    } catch {
      // Run state is best-effort; never fail the pipeline over bookkeeping.
    }
  }

  get(runId: string): RunRecord | undefined {
    const path = this.runPath(runId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as RunRecord;
    } catch {
      return undefined;
    }
  }

  list(limit = 20): RunRecord[] {
    if (!existsSync(this.runsDir)) return [];
    const records: RunRecord[] = [];
    for (const file of readdirSync(this.runsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        records.push(JSON.parse(readFileSync(join(this.runsDir, file), 'utf-8')) as RunRecord);
      } catch {
        // skip unreadable record
      }
    }
    return records
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /** Latest succeeded run for an idempotency key, if any. */
  findByIdempotencyKey(key: string): RunRecord | undefined {
    return this.list(MAX_RUNS_KEPT).find(
      (run) => run.idempotencyKey === key && run.status === 'succeeded',
    );
  }

  /**
   * Mark a phase as started; completes the previous phase with its duration.
   */
  markPhase(record: RunRecord, phase: PipelinePhase): void {
    const now = new Date();
    if (record.currentPhase && record.currentPhase !== phase && record.currentPhase !== 'done') {
      const started = new Date(record.updatedAt).getTime();
      record.phases[record.currentPhase] = {
        completedAt: now.toISOString(),
        durationMs: Math.max(0, now.getTime() - started),
      };
    }
    record.currentPhase = phase;
    this.save(record);
  }

  complete(record: RunRecord, fields: Partial<RunRecord> = {}): void {
    Object.assign(record, fields);
    record.status = 'succeeded';
    record.currentPhase = 'done';
    this.save(record);
  }

  fail(record: RunRecord, error: string, errorCode?: string, fields: Partial<RunRecord> = {}): void {
    Object.assign(record, fields);
    record.status = 'failed';
    record.error = error;
    record.errorCode = errorCode;
    this.save(record);
  }

  addTokenUsage(record: RunRecord, usage: RunTokenUsage): void {
    const existing = record.tokenUsage;
    record.tokenUsage = existing
      ? {
          promptTokens: existing.promptTokens + usage.promptTokens,
          completionTokens: existing.completionTokens + usage.completionTokens,
          estimated: existing.estimated || usage.estimated,
        }
      : usage;
    this.save(record);
  }

  /** Median duration of a phase across recent succeeded runs (ms), if known. */
  typicalPhaseDuration(phase: PipelinePhase): number | undefined {
    const durations = this.list(MAX_RUNS_KEPT)
      .filter((run) => run.status === 'succeeded')
      .map((run) => run.phases[phase]?.durationMs)
      .filter((ms): ms is number => typeof ms === 'number' && ms > 0)
      .sort((a, b) => a - b);
    if (durations.length === 0) return undefined;
    return durations[Math.floor(durations.length / 2)];
  }

  /** Aggregate stats for /doctor: counts and most common failure phase. */
  summarize(limit = 50): {
    total: number;
    succeeded: number;
    failed: number;
    failuresByPhase: Record<string, number>;
    totalTokens: number;
  } {
    const runs = this.list(limit);
    const failuresByPhase: Record<string, number> = {};
    let totalTokens = 0;
    let succeeded = 0;
    let failed = 0;
    for (const run of runs) {
      if (run.status === 'succeeded') succeeded++;
      if (run.status === 'failed') {
        failed++;
        const phase = run.currentPhase ?? 'unknown';
        failuresByPhase[phase] = (failuresByPhase[phase] ?? 0) + 1;
      }
      if (run.tokenUsage) {
        totalTokens += run.tokenUsage.promptTokens + run.tokenUsage.completionTokens;
      }
    }
    return { total: runs.length, succeeded, failed, failuresByPhase, totalTokens };
  }

  private prune(): void {
    try {
      const all = this.list(Number.MAX_SAFE_INTEGER);
      for (const stale of all.slice(MAX_RUNS_KEPT)) {
        unlinkSync(this.runPath(stale.runId));
      }
    } catch {
      // best-effort
    }
  }

  private runPath(runId: string): string {
    // runIds are generated internally (date + uuid slice); sanitize anyway.
    const safe = runId.replace(/[^A-Za-z0-9_-]/g, '');
    return join(this.runsDir, `${safe}.json`);
  }
}

export default RunStateService;
