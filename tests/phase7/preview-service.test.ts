import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCrossSpawnLive, mockKillProcess } = vi.hoisted(() => ({
  mockCrossSpawnLive: vi.fn(),
  mockKillProcess: vi.fn(),
}));

vi.mock('../../src/utils/crossSpawn.js', () => ({
  crossSpawnLive: mockCrossSpawnLive,
  killProcess: mockKillProcess,
}));

import { PreviewService } from '../../src/services/deploy/PreviewService.js';

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    exitCode: number | null;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.exitCode = null;
  return proc;
}

describe('PreviewService', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'openboard-preview-'));
    writeFileSync(join(projectDir, 'package.json'), '{"scripts":{"dev":"vite"}}');
    mockCrossSpawnLive.mockReset();
    mockKillProcess.mockReset();
  });

  afterEach(() => {
    PreviewService.stopAll();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('passes the selected host and port directly to Vite and reports the same URL', async () => {
    const proc = fakeProcess();
    mockCrossSpawnLive.mockReturnValue(proc);

    const starting = PreviewService.start(projectDir, 55173);
    await vi.waitFor(() => expect(mockCrossSpawnLive).toHaveBeenCalledOnce());
    const args = mockCrossSpawnLive.mock.calls[0][1] as string[];
    const selectedPort = Number(args[args.indexOf('--port') + 1]);

    proc.stdout.emit('data', Buffer.from(`\n  Local:   http://127.0.0.1:${selectedPort}/\n`));
    const result = await starting;

    expect(args).toEqual([
      'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(selectedPort), '--strictPort',
    ]);
    expect(result).toMatchObject({
      success: true,
      port: selectedPort,
      url: `http://127.0.0.1:${selectedPort}`,
    });
    expect(PreviewService.isRunning(projectDir)).toBe(true);
  });

  it('returns the actual existing preview URL instead of the caller requested port', async () => {
    const proc = fakeProcess();
    mockCrossSpawnLive.mockReturnValue(proc);

    const starting = PreviewService.start(projectDir, 55193);
    await vi.waitFor(() => expect(mockCrossSpawnLive).toHaveBeenCalledOnce());
    const args = mockCrossSpawnLive.mock.calls[0][1] as string[];
    const selectedPort = Number(args[args.indexOf('--port') + 1]);
    proc.stdout.emit('data', Buffer.from(`ready in 100 ms\nLocal: http://127.0.0.1:${selectedPort}/`));
    const first = await starting;
    const second = await PreviewService.start(projectDir, 55999);

    expect(second.url).toBe(first.url);
    expect(second.port).toBe(first.port);
    expect(mockCrossSpawnLive).toHaveBeenCalledTimes(1);
  });
});
