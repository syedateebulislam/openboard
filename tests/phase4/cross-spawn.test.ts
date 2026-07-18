import { describe, it, expect } from 'vitest';
import { resolveSpawnCommand, resolveSpawnInvocation, crossSpawn } from '../../src/utils/crossSpawn.js';

describe('crossSpawn command resolution', () => {
  it('should resolve Windows CLI shims without enabling shell parsing', () => {
    expect(resolveSpawnCommand('npm', false, true)).toBe('npm.cmd');
    expect(resolveSpawnCommand('npx', false, true)).toBe('npx.cmd');
    expect(resolveSpawnCommand('vercel', false, true)).toBe('vercel.cmd');
    expect(resolveSpawnCommand('codex', false, true)).toBe('codex.cmd');

    expect(resolveSpawnInvocation('npm', ['run', 'dev'], false, true, 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'dev'],
      useShell: false,
    });
  });

  it('should not rewrite commands when shell execution is explicitly requested', () => {
    expect(resolveSpawnCommand('npm', true, true)).toBe('npm');
  });

  it('should not rewrite commands on non-Windows platforms', () => {
    expect(resolveSpawnCommand('npm', false, false)).toBe('npm');
    expect(resolveSpawnCommand('git', false, false)).toBe('git');
  });
});

describe('crossSpawn process lifecycle', () => {
  it('pipes stdin without exposing it in argv', async () => {
    const result = await crossSpawn(process.execPath, [
      '-e',
      "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s))",
    ], { cwd: process.cwd(), stdin: 'private-value', timeoutMs: 5_000 });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('private-value');
  });

  it('bounds retained output while preserving the newest diagnostics', async () => {
    const result = await crossSpawn(process.execPath, [
      '-e',
      "process.stdout.write('a'.repeat(2000)+'TAIL')",
    ], { cwd: process.cwd(), maxOutputBytes: 128, timeoutMs: 5_000 });

    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdout.endsWith('TAIL')).toBe(true);
  });
});
