/**
 * Phase 8 — agentic pipeline enhancements:
 *  - error code classification (stable agent contract)
 *  - pipeline phase model + reporter events
 *  - run state persistence (resume / idempotency / history)
 *  - project lockfile (concurrent run protection)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { classifyAgentError, isLLMQuotaError, describeLLMError } from '../../src/utils/errorCodes.js';
import {
  PHASE_ORDER,
  PHASE_WEIGHTS,
  phaseStartPct,
  PipelineReporter,
} from '../../src/services/project/pipelinePhases.js';
import type { PipelineEvent } from '../../src/services/project/pipelinePhases.js';
import { RunStateService } from '../../src/services/project/RunStateService.js';
import { ProjectLockService } from '../../src/services/project/ProjectLockService.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openboard-phase8-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ════════════════════════════════════════════════════════════════════════════
// Error codes
// ════════════════════════════════════════════════════════════════════════════

describe('classifyAgentError', () => {
  it.each([
    ['Missing required --data <csv|json> for agent create.', 'E_VALIDATION'],
    ['Dashboard not found: uber-rides', 'E_DASHBOARD_NOT_FOUND'],
    ['Run not found: run-2026-06-10-abc', 'E_RUN_NOT_FOUND'],
    ['Project is locked by another OpenBoard run (pid 123, since ...)', 'E_LOCKED'],
    ['ENOENT: no such file or directory', 'E_DATA_NOT_FOUND'],
    ['No LLM provider configured. Configure LLM settings first.', 'E_NO_LLM'],
    ['LLM did not return any writable files.', 'E_LLM_EMPTY'],
    ['Scaffold failed: template missing', 'E_SCAFFOLD_FAILED'],
    ['Install failed: npm exited 1', 'E_INSTALL_FAILED'],
    ['Build failed: vite error in App.tsx', 'E_BUILD_FAILED'],
    ['Deploy failed: project link error', 'E_DEPLOY_FAILED'],
    ['Vercel is not authenticated. Run vercel login.', 'E_DEPLOY_AUTH'],
    ['Deployment verification failed after 3 attempts: GET / returned HTTP 404', 'E_VERIFY_FAILED'],
  ])('classifies %j as %s', (message, expected) => {
    expect(classifyAgentError(message)).toBe(expected);
  });

  it('returns E_UNKNOWN for unclassifiable or empty errors', () => {
    expect(classifyAgentError('something inexplicable happened')).toBe('E_UNKNOWN');
    expect(classifyAgentError(undefined)).toBe('E_UNKNOWN');
    expect(classifyAgentError('')).toBe('E_UNKNOWN');
  });

  it.each([
    'You exceeded your current quota, please check your plan and billing details.',
    'Error code: 429 - insufficient_quota',
    'ERROR: Reconnecting... 5/5',
    'rate limit reached for requests',
    'stream disconnected before completion',
  ])('classifies quota/rate-limit error %j as E_LLM_QUOTA', (message) => {
    expect(classifyAgentError(message)).toBe('E_LLM_QUOTA');
    expect(isLLMQuotaError(message)).toBe(true);
  });

  it('describeLLMError surfaces an actionable quota message, else the raw error', () => {
    const quota = describeLLMError('insufficient_quota', 'openai-codex');
    expect(quota).toMatch(/quota or credits/i);
    expect(quota).toContain('openai-codex');
    expect(quota).toMatch(/\/config/);
    expect(describeLLMError('Build failed: vite error')).toBe('Build failed: vite error');
    expect(isLLMQuotaError('Build failed: vite error')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase model + reporter
// ════════════════════════════════════════════════════════════════════════════

describe('pipeline phases', () => {
  it('weights sum to 100', () => {
    const total = PHASE_ORDER.reduce((sum, phase) => sum + PHASE_WEIGHTS[phase], 0);
    expect(total).toBe(100);
  });

  it('phaseStartPct is monotonically increasing along PHASE_ORDER', () => {
    let last = -1;
    for (const phase of PHASE_ORDER) {
      const pct = phaseStartPct(phase);
      expect(pct).toBeGreaterThanOrEqual(last);
      last = pct;
    }
    expect(phaseStartPct('parse')).toBe(0);
  });

  it('reporter emits phase events with pct and fans log lines to both sinks', () => {
    const events: PipelineEvent[] = [];
    const lines: string[] = [];
    const reporter = new PipelineReporter((line) => lines.push(line), (event) => events.push(event));

    reporter.phase('build');
    reporter.log('Building project...');
    reporter.phase('done');
    reporter.result(true);

    expect(lines).toEqual(['Building project...']);
    const phaseEvents = events.filter((e) => e.event === 'phase');
    expect(phaseEvents[0]).toMatchObject({ phase: 'build', pct: phaseStartPct('build') });
    expect(phaseEvents[1]).toMatchObject({ phase: 'done', pct: 100 });
    expect(events.some((e) => e.event === 'log' && e.message === 'Building project...')).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: 'result', success: true });
  });

  it('log lines advance within-phase percent but never cross the next phase boundary', () => {
    const events: PipelineEvent[] = [];
    const reporter = new PipelineReporter(undefined, (event) => events.push(event));
    reporter.phase('build');
    for (let i = 0; i < 200; i++) reporter.log(`line ${i}`);

    const pcts = events.filter((e) => e.event === 'log' && e.pct !== undefined).map((e) => e.pct!);
    const buildStart = phaseStartPct('build');
    const nextStart = buildStart + PHASE_WEIGHTS.build;
    expect(Math.max(...pcts)).toBeLessThan(nextStart);
    expect(Math.min(...pcts)).toBeGreaterThanOrEqual(buildStart);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Run state
// ════════════════════════════════════════════════════════════════════════════

describe('RunStateService', () => {
  let configDir: string;
  let runs: RunStateService;

  beforeEach(() => {
    configDir = makeTempDir();
    runs = new RunStateService(configDir);
  });

  afterEach(() => {
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch {
      // Windows file locks — ignore
    }
  });

  it('creates, persists, and reloads a run record', () => {
    const run = runs.createRun('create', { dataFile: 'rides.csv' }, 'key-1');
    expect(run.runId).toMatch(/^run-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
    expect(existsSync(join(configDir, 'runs', `${run.runId}.json`))).toBe(true);

    const reloaded = runs.get(run.runId);
    expect(reloaded).toMatchObject({
      runId: run.runId,
      action: 'create',
      status: 'running',
      idempotencyKey: 'key-1',
      options: { dataFile: 'rides.csv' },
    });
  });

  it('marks phases with durations and completes the run', () => {
    const run = runs.createRun('create', {});
    runs.markPhase(run, 'parse');
    runs.markPhase(run, 'generate');
    runs.complete(run, { deployUrl: 'https://example.vercel.app', writtenFiles: ['App.tsx'] });

    const reloaded = runs.get(run.runId)!;
    expect(reloaded.status).toBe('succeeded');
    expect(reloaded.currentPhase).toBe('done');
    expect(reloaded.phases.parse?.durationMs).toBeGreaterThanOrEqual(0);
    expect(reloaded.deployUrl).toBe('https://example.vercel.app');
  });

  it('finds succeeded runs by idempotency key, ignoring failed ones', () => {
    const failed = runs.createRun('create', {}, 'shared-key');
    runs.fail(failed, 'Build failed: boom', 'E_BUILD_FAILED');
    expect(runs.findByIdempotencyKey('shared-key')).toBeUndefined();

    const ok = runs.createRun('create', {}, 'shared-key');
    runs.complete(ok, {});
    expect(runs.findByIdempotencyKey('shared-key')?.runId).toBe(ok.runId);
  });

  it('accumulates token usage and surfaces it in the summary', () => {
    const run = runs.createRun('create', {});
    runs.addTokenUsage(run, { promptTokens: 1000, completionTokens: 500, estimated: false });
    runs.addTokenUsage(run, { promptTokens: 200, completionTokens: 100, estimated: true });
    runs.complete(run, {});

    const reloaded = runs.get(run.runId)!;
    expect(reloaded.tokenUsage).toEqual({ promptTokens: 1200, completionTokens: 600, estimated: true });
    expect(runs.summarize().totalTokens).toBe(1800);
  });

  it('summarizes failures by phase', () => {
    const a = runs.createRun('create', {});
    runs.markPhase(a, 'build');
    runs.fail(a, 'Build failed', 'E_BUILD_FAILED');
    const b = runs.createRun('update', {});
    runs.markPhase(b, 'build');
    runs.fail(b, 'Build failed', 'E_BUILD_FAILED');
    const c = runs.createRun('refresh', {});
    runs.complete(c, {});

    const summary = runs.summarize();
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.failuresByPhase.build).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Project lock
// ════════════════════════════════════════════════════════════════════════════

describe('ProjectLockService', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
  });

  afterEach(() => {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('acquires and releases a lock', () => {
    const lock = ProjectLockService.acquire(projectDir);
    expect(lock.success).toBe(true);
    expect(existsSync(join(projectDir, '.openboard.lock'))).toBe(true);

    lock.release();
    expect(existsSync(join(projectDir, '.openboard.lock'))).toBe(false);
  });

  it('reacquires a lock held by this (alive) process — same-process lock is not stale', () => {
    // A lock from our own live pid blocks a second acquire.
    const first = ProjectLockService.acquire(projectDir);
    expect(first.success).toBe(true);
    const second = ProjectLockService.acquire(projectDir);
    expect(second.success).toBe(false);
    expect(second.error).toContain('locked by another OpenBoard run');
    first.release();
  });

  it('breaks a stale lock from a dead process', () => {
    // Fake a lock from a pid that should not exist.
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(
      join(projectDir, '.openboard.lock'),
      JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString() }),
    );

    const lock = ProjectLockService.acquire(projectDir);
    expect(lock.success).toBe(true);
    lock.release();
  });

  it('release is idempotent and only removes its own lock', () => {
    const lock = ProjectLockService.acquire(projectDir);
    lock.release();
    lock.release(); // second release is a no-op
    expect(existsSync(join(projectDir, '.openboard.lock'))).toBe(false);
  });
});
