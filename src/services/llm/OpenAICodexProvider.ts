/**
 * OpenAICodexProvider — OpenAI Codex CLI backed LLM provider.
 *
 * This provider is for users who want to authenticate with their ChatGPT/Codex
 * subscription instead of pasting an OpenAI Platform API key. It delegates auth
 * and model execution to the official `codex` CLI.
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type {
  LLMProvider,
  LLMCompletionOptions,
  LLMStreamChunk,
  LLMValidationResult,
  LLMMessage,
} from '../../types/llm.js';
import { crossSpawn, resolveSpawnInvocation } from '../../utils/crossSpawn.js';
import { sanitizeErrorMessage } from '../../utils/logger.js';

type ProgressCallback = (line: string) => void;

/**
 * OpenBoard runs codex with a dedicated CODEX_HOME so its ChatGPT/Codex login
 * is isolated from OpenClaw and any manual `codex` usage. Sharing one home
 * means a rotating chatgpt refresh token gets invalidated whenever another
 * process refreshes it — the "auth dies after ~1 hour, re-login fixes it"
 * symptom. With its own home, OpenBoard logs in once and codex keeps it
 * refreshed.
 *
 * The location is OPENBOARD_CODEX_HOME (override) or ~/.openboard/codex-home.
 * The ambient CODEX_HOME is intentionally IGNORED: when a parent tool like
 * OpenClaw spawns `openboard agent`, OpenBoard would otherwise inherit that
 * tool's CODEX_HOME — a differently authed home — making the codex subprocess
 * look "not logged in". Pinning our own home keeps the agent CLI working
 * regardless of who launched it.
 */
export function codexHome(): string {
  const home = process.env.OPENBOARD_CODEX_HOME?.trim() || join(homedir(), '.openboard', 'codex-home');
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    // Best effort — codex will surface a clearer error if the dir is unusable.
  }
  return home;
}

/** Env for every spawned codex process: inherit the shell env, pin CODEX_HOME. */
function codexEnv(): Record<string, string | undefined> {
  return { ...process.env, CODEX_HOME: codexHome() };
}

/** True when codex output indicates the dedicated home has no/expired login. */
export function isCodexAuthError(text: string | undefined): boolean {
  if (!text) return false;
  return /not logged in|no credentials|unauthorized|401|please (?:run )?`?codex login|authentication required|auth\.json/i.test(text);
}

function messagesToPrompt(messages: LLMMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase();
      return `${role}:\n${message.content}`;
    })
    .join('\n\n');
}

// Kill the spawned process AND its children. codex spawns a model runtime
// subprocess; a bare proc.kill() leaves it orphaned (especially on Windows).
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      /* best effort */
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* best effort */
    }
  }
}

function runWithStdin(
  cmd: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  onProgress?: ProgressCallback,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const invocation = resolveSpawnInvocation(cmd, args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      shell: invocation.useShell,
      env: codexEnv(),
    });

    let stdout = '';
    let stderr = '';
    const start = Date.now();

    // Heartbeat so non-interactive callers (and agent runners that poll for
    // output) can see the generation is alive even while codex is silent.
    const heartbeat = onProgress
      ? setInterval(() => {
          const elapsed = Math.round((Date.now() - start) / 1000);
          onProgress(`  codex still generating… ${elapsed}s elapsed`);
        }, 12_000)
      : undefined;
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
    };

    const timer = setTimeout(() => {
      stopHeartbeat();
      killProcessTree(proc.pid);
      proc.kill();
      reject(new Error(`Command "${cmd}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // codex writes status/progress to stderr; surface trimmed lines as liveness.
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (onProgress) {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) onProgress(`  codex: ${trimmed.slice(0, 180)}`);
        }
      }
    });

    proc.on('error', (err) => {
      stopHeartbeat();
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      stopHeartbeat();
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.stdin?.write(stdin);
    proc.stdin?.end();
  });
}

/** Matches codex's "you're signed in" output across its login variants. */
const LOGIN_SUCCESS = /successfully logged in|already logged in|logged in to/i;

/**
 * Run a `codex login [...]` variant and resolve as soon as sign-in succeeds.
 *
 * codex's browser login starts a local callback server that can linger after
 * printing "Successfully logged in", so waiting for the process to exit (as a
 * plain crossSpawn does) wedges the caller on a spinner. Instead, watch the
 * output: on the success marker, give codex a short grace period to exit on its
 * own, then confirm with `codex login status` and move on — killing the
 * lingering process. Also resolves on natural exit and a hard timeout.
 *
 * `stdin` feeds token/key flows (`--with-access-token`, `--with-api-key`).
 */
function runCodexLoginCommand(
  args: string[],
  onProgress?: ProgressCallback,
  stdin?: string,
  timeoutMs = 5 * 60_000,
): Promise<LLMValidationResult> {
  return new Promise((resolve) => {
    const invocation = resolveSpawnInvocation('codex', args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      shell: invocation.useShell,
      env: codexEnv(),
    });

    let out = '';
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: LLMValidationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      killProcessTree(proc.pid);
      proc.kill();
      resolve(result);
    };

    const hardTimer = setTimeout(
      () => finish({ valid: false, error: 'Codex login timed out. Re-select OpenAI Codex to retry.' }),
      timeoutMs,
    );

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      out += text;
      if (onProgress) {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) onProgress(trimmed.slice(0, 180));
        }
      }
      if (!graceTimer && LOGIN_SUCCESS.test(out)) {
        onProgress?.('Sign-in detected, confirming…');
        // Give codex a moment to flush auth.json and exit on its own; if it
        // lingers, confirm via status and proceed.
        graceTimer = setTimeout(() => {
          if (settled) return;
          new OpenAICodexProvider('').validate().then((status) => {
            if (status.valid) finish({ valid: true });
          }).catch(() => { /* fall through to natural close / hard timeout */ });
        }, 6_000);
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('close', (code) => {
      finish(code === 0 || LOGIN_SUCCESS.test(out)
        ? { valid: true }
        : { valid: false, error: sanitizeErrorMessage(out || 'Codex login failed') });
    });
    proc.on('error', (err) => finish({ valid: false, error: sanitizeErrorMessage(err.message) }));

    if (stdin !== undefined) {
      proc.stdin?.write(stdin.endsWith('\n') ? stdin : `${stdin}\n`);
      proc.stdin?.end();
    }
  });
}

export class OpenAICodexProvider implements LLMProvider {
  readonly name = 'openai-codex';
  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  static async loginWithBrowser(onProgress?: ProgressCallback): Promise<LLMValidationResult> {
    try {
      onProgress?.(`Signing in to OpenBoard's own codex home: ${codexHome()}`);
      onProgress?.('A browser window will open for OpenAI Codex sign-in. Complete it, then return here.');
      onProgress?.('Headless/remote? Run: codex login --device-auth (with CODEX_HOME set to the path above).');
      return await runCodexLoginCommand(['login'], onProgress);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: sanitizeErrorMessage(msg) };
    }
  }

  /**
   * Device-auth sign-in for headless/agent flows: codex prints a URL + code
   * (streamed via onProgress so an agent can relay them) and polls until the
   * user authenticates. No browser or TUI required on this machine.
   */
  static async loginWithDeviceAuth(onProgress?: ProgressCallback): Promise<LLMValidationResult> {
    try {
      onProgress?.(`Signing in to OpenBoard's own codex home: ${codexHome()}`);
      onProgress?.('Open the URL below and enter the code to authorize OpenAI Codex:');
      return await runCodexLoginCommand(['login', '--device-auth'], onProgress, undefined, 10 * 60_000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: sanitizeErrorMessage(msg) };
    }
  }

  /** Fully headless sign-in from a ChatGPT/Codex access token (read via stdin). */
  static async loginWithAccessToken(token: string, onProgress?: ProgressCallback): Promise<LLMValidationResult> {
    try {
      onProgress?.(`Signing in to OpenBoard's own codex home with an access token: ${codexHome()}`);
      return await runCodexLoginCommand(['login', '--with-access-token'], onProgress, token, 60_000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: sanitizeErrorMessage(msg) };
    }
  }

  /** Fully headless sign-in from an OpenAI API key (read via stdin). */
  static async loginWithApiKey(apiKey: string, onProgress?: ProgressCallback): Promise<LLMValidationResult> {
    try {
      onProgress?.(`Signing in to OpenBoard's own codex home with an API key: ${codexHome()}`);
      return await runCodexLoginCommand(['login', '--with-api-key'], onProgress, apiKey, 60_000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: sanitizeErrorMessage(msg) };
    }
  }

  async validate(): Promise<LLMValidationResult> {
    try {
      const result = await crossSpawn('codex', ['login', 'status'], {
        cwd: process.cwd(),
        timeoutMs: 20_000,
        env: { CODEX_HOME: codexHome() },
      });

      if (result.code === 0) {
        return { valid: true };
      }

      return {
        valid: false,
        error: sanitizeErrorMessage(result.stderr || result.stdout || 'Codex is not logged in.'),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        error: `Codex CLI is not available or not logged in: ${sanitizeErrorMessage(msg)}`,
      };
    }
  }

  async listModels(): Promise<string[]> {
    return [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
    ];
  }

  async complete(options: LLMCompletionOptions): Promise<string> {
    const outputFile = join(tmpdir(), `openboard-codex-${randomUUID()}.txt`);
    const prompt = messagesToPrompt(options.messages);

    options.onProgress?.(`Running codex (${this.model})…`);
    const result = await runWithStdin(
      'codex',
      [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--model',
        this.model,
        '--output-last-message',
        outputFile,
        '-',
      ],
      prompt,
      10 * 60_000,
      options.onProgress,
    );

    try {
      const lastMessage = await readFile(outputFile, 'utf-8').catch(() => '');
      if (result.code === 0 && lastMessage.trim()) {
        return lastMessage;
      }

      if (result.code === 0 && result.stdout.trim()) {
        return result.stdout;
      }

      const rawError = result.stderr || result.stdout || 'Codex exec failed';
      if (isCodexAuthError(rawError)) {
        throw new Error(
          `OpenAI Codex is not signed in for OpenBoard. OpenBoard keeps its own codex login at ${codexHome()} ` +
          `(separate from other tools). Open "openboard" → Settings → LLM → OpenAI Codex to sign in once, then retry.`,
        );
      }
      throw new Error(rawError);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(sanitizeErrorMessage(msg));
    } finally {
      await rm(outputFile, { force: true }).catch(() => {});
    }
  }

  async *stream(options: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const text = await this.complete(options);
    yield { text, done: true };
  }
}

export default OpenAICodexProvider;
