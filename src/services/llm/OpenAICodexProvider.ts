/**
 * OpenAICodexProvider — OpenAI Codex CLI backed LLM provider.
 *
 * This provider is for users who want to authenticate with their ChatGPT/Codex
 * subscription instead of pasting an OpenAI Platform API key. It delegates auth
 * and model execution to the official `codex` CLI.
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

function messagesToPrompt(messages: LLMMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase();
      return `${role}:\n${message.content}`;
    })
    .join('\n\n');
}

function runWithStdin(
  cmd: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const invocation = resolveSpawnInvocation(cmd, args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      shell: invocation.useShell,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command "${cmd}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.stdin?.write(stdin);
    proc.stdin?.end();
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
      onProgress?.('Opening Codex device login. Follow the URL/code shown by Codex.');
      const result = await crossSpawn('codex', ['login', '--device-auth'], {
        cwd: process.cwd(),
        timeoutMs: 10 * 60_000,
        onProgress,
      });

      if (result.code === 0) {
        return { valid: true };
      }

      return {
        valid: false,
        error: sanitizeErrorMessage(result.stderr || result.stdout || 'Codex login failed'),
      };
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
    );

    try {
      const lastMessage = await readFile(outputFile, 'utf-8').catch(() => '');
      if (result.code === 0 && lastMessage.trim()) {
        return lastMessage;
      }

      if (result.code === 0 && result.stdout.trim()) {
        return result.stdout;
      }

      throw new Error(result.stderr || result.stdout || 'Codex exec failed');
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
