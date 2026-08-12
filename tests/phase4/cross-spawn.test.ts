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

  it('should reject arguments that could chain a second cmd.exe command', () => {
    for (const bad of ['a & calc', 'a | calc', 'a > out.txt', 'a < in.txt', 'a ^ b', 'a\nb']) {
      expect(
        () => resolveSpawnInvocation('npm', ['run', bad], false, true, 'cmd.exe'),
        bad,
      ).toThrow(/Unsafe argument/);
    }
  });

  it('should accept the quoted config values real commands pass', () => {
    // Regression: the guard first shipped denying `"` as well, which broke
    // every codex generation — the provider passes
    // `-c model_reasoning_effort="medium"`, where JSON.stringify's quotes are
    // structural to codex's config parser. A quote only matters by exposing a
    // later separator, and separators are rejected above.
    const args = ['exec', '-c', 'model_reasoning_effort="medium"', '--output-last-message', 'C:\\tmp\\out.txt'];
    expect(() => resolveSpawnInvocation('codex', args, false, true, 'cmd.exe')).not.toThrow();
    expect(resolveSpawnInvocation('codex', args, false, true, 'cmd.exe').args).toEqual([
      '/d', '/s', '/c', 'codex.cmd', ...args,
    ]);
  });

  it('should not reject the ordinary Windows paths that reach npm and vercel', () => {
    for (const arg of ['C:\\Users\\RUNNER~1\\board', 'C:\\Program Files (x86)\\node', '--prefix=./dist']) {
      expect(
        () => resolveSpawnInvocation('npm', ['run', 'build', arg], false, true, 'cmd.exe'),
        arg,
      ).not.toThrow();
    }
  });

  it('should not rewrite commands on non-Windows platforms', () => {
    expect(resolveSpawnCommand('npm', false, false)).toBe('npm');
    expect(resolveSpawnCommand('git', false, false)).toBe('git');
  });
});

describe('crossSpawn environment isolation', () => {
  // The child here stands in for a generated invoice fetcher: it prints back
  // whatever it can see, and the test asserts what it cannot.
  const printEnv = (name: string) => [
    '-e',
    `process.stdout.write(String(process.env[${JSON.stringify(name)}] ?? ''))`,
  ];

  it('keeps the parent process secrets out of an isolated child', async () => {
    process.env.OPENBOARD_TEST_FAKE_SECRET = 'must-not-leak';
    try {
      const result = await crossSpawn(process.execPath, printEnv('OPENBOARD_TEST_FAKE_SECRET'), {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        isolateEnv: true,
      });
      expect(result.stdout).toBe('');
    } finally {
      delete process.env.OPENBOARD_TEST_FAKE_SECRET;
    }
  });

  it('still hands an isolated child the credentials it was given explicitly', async () => {
    const result = await crossSpawn(process.execPath, printEnv('OPENBOARD_GMAIL_APP_PASSWORD'), {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      isolateEnv: true,
      env: { OPENBOARD_GMAIL_APP_PASSWORD: 'app-password' },
    });
    expect(result.stdout).toBe('app-password');
  });

  it('keeps PATH so the interpreter can still be found', async () => {
    // Isolation that breaks process startup would just get reverted, so the
    // passthrough list is part of the contract, not an implementation detail.
    const result = await crossSpawn(process.execPath, printEnv('PATH'), {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      isolateEnv: true,
    });
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('inherits the full environment when isolation is not requested', async () => {
    process.env.OPENBOARD_TEST_FAKE_SECRET = 'inherited';
    try {
      const result = await crossSpawn(process.execPath, printEnv('OPENBOARD_TEST_FAKE_SECRET'), {
        cwd: process.cwd(),
        timeoutMs: 5_000,
      });
      expect(result.stdout).toBe('inherited');
    } finally {
      delete process.env.OPENBOARD_TEST_FAKE_SECRET;
    }
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

  it('rejects immediately with an AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      crossSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('kills the child process and rejects with AbortError when aborted mid-flight — this is what /stop relies on', async () => {
    const controller = new AbortController();
    const promise = crossSpawn(process.execPath, [
      '-e',
      "setTimeout(() => process.stdout.write('should not print'), 5000)",
    ], { cwd: process.cwd(), timeoutMs: 10_000, signal: controller.signal });

    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
