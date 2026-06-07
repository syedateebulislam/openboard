import { describe, it, expect } from 'vitest';
import { resolveSpawnCommand, resolveSpawnInvocation } from '../../src/utils/crossSpawn.js';

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
