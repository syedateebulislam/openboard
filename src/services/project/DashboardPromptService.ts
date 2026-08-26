import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AGENT_DEFAULT_PROMPT,
  DASHBOARD_PROMPTS,
  FINAL_FALLBACK_PROMPT,
} from '../../config/dashboardPrompts.js';
import type { BoardConfig } from '../../types/board.js';
import type { LLMMessage } from '../../types/llm.js';
import { VERSION } from '../../version.js';
import { ConfigService } from '../config/ConfigService.js';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_LOW } from '../llm/prompts/systemPrompt.js';
import type { PromptHistoryEntry, PromptRequestAudit } from './PromptHistoryService.js';

export type PromptCustomizationAction = 'append' | 'set' | 'clear';

export interface PromptCustomizationChange {
  action: PromptCustomizationAction;
  text: string;
  createdAt: string;
}

interface StoredPromptCustomization {
  boardId: string;
  appended: string;
  changes: PromptCustomizationChange[];
}

export interface DashboardPromptProfile {
  cliVersion: string;
  systemProfile: 'high' | 'low';
  frameworkPrompt: string;
  frameworkHash: string;
  defaultSource: string;
  defaultPrompt: string;
  defaultHash: string;
  appendedPrompt: string;
  appendedHash?: string;
  effectivePrompt: string;
  effectiveHash: string;
}

export type PromptFreshness = 'current' | 'stale' | 'legacy' | 'never-generated';

export interface PromptAuditStatus {
  freshness: PromptFreshness;
  latest?: PromptHistoryEntry;
}

export function promptHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shortHash(value: string | undefined): string {
  return value ? value.slice(0, 12) : 'none';
}

function safeProfileFileName(boardId: string): string {
  const readable = boardId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'dashboard';
  return `${readable}-${promptHash(boardId).slice(0, 8)}.json`;
}

function parseStored(value: unknown, boardId: string): StoredPromptCustomization {
  if (!value || typeof value !== 'object') return { boardId, appended: '', changes: [] };
  const candidate = value as Partial<StoredPromptCustomization>;
  return {
    boardId,
    appended: typeof candidate.appended === 'string' ? candidate.appended : '',
    changes: Array.isArray(candidate.changes)
      ? candidate.changes.filter((change): change is PromptCustomizationChange => Boolean(
          change &&
          typeof change === 'object' &&
          ['append', 'set', 'clear'].includes((change as PromptCustomizationChange).action) &&
          typeof (change as PromptCustomizationChange).text === 'string' &&
          typeof (change as PromptCustomizationChange).createdAt === 'string',
        ))
      : [],
  };
}

/**
 * Owns the persistent, per-dashboard prompt overlay and computes provenance
 * for the exact package prompts in use. Shipped defaults are never copied into
 * user config, so upgrading OpenBoardCLI immediately exposes the new defaults.
 */
export class DashboardPromptService {
  private readonly profilesDir: string;

  constructor(config = new ConfigService()) {
    this.profilesDir = join(dirname(config.configPath), 'dashboard-prompts');
  }

  private pathFor(boardId: string): string {
    return join(this.profilesDir, safeProfileFileName(boardId));
  }

  private readStored(boardId: string): StoredPromptCustomization {
    const path = this.pathFor(boardId);
    if (!existsSync(path)) return { boardId, appended: '', changes: [] };
    try {
      return parseStored(JSON.parse(readFileSync(path, 'utf-8')), boardId);
    } catch {
      return { boardId, appended: '', changes: [] };
    }
  }

  private writeStored(value: StoredPromptCustomization): void {
    mkdirSync(this.profilesDir, { recursive: true });
    const path = this.pathFor(value.boardId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(temporary, path);
  }

  profile(board: BoardConfig): DashboardPromptProfile {
    const systemProfile = board.uiQuality === 'low' ? 'low' : 'high';
    const frameworkPrompt = systemProfile === 'low' ? SYSTEM_PROMPT_LOW : SYSTEM_PROMPT;
    const usesAgentDefault = board.promptBase === 'agent-default';
    const defaultPrompt = usesAgentDefault
      ? AGENT_DEFAULT_PROMPT
      : DASHBOARD_PROMPTS[board.type] || FINAL_FALLBACK_PROMPT;
    const defaultSource = usesAgentDefault ? 'agent-default.md' : `${board.type}.md`;
    const appendedPrompt = this.readStored(board.id).appended.trim();
    const effectivePrompt = appendedPrompt
      ? `${defaultPrompt}\n\nADDITIONAL DASHBOARD INSTRUCTIONS (persisted for this dashboard):\n${appendedPrompt}`
      : defaultPrompt;

    return {
      cliVersion: VERSION,
      systemProfile,
      frameworkPrompt,
      frameworkHash: promptHash(frameworkPrompt),
      defaultSource,
      defaultPrompt,
      defaultHash: promptHash(defaultPrompt),
      appendedPrompt,
      appendedHash: appendedPrompt ? promptHash(appendedPrompt) : undefined,
      effectivePrompt,
      effectiveHash: promptHash(effectivePrompt),
    };
  }

  composeRequestIntent(board: BoardConfig, request?: string): string {
    const profile = this.profile(board);
    const specific = request?.trim();
    return specific
      ? `${profile.effectivePrompt}\n\nREQUEST-SPECIFIC INSTRUCTIONS:\n${specific}`
      : profile.effectivePrompt;
  }

  createAudit(board: BoardConfig, messages: LLMMessage[]): PromptRequestAudit {
    const profile = this.profile(board);
    const serialized = JSON.stringify(messages.map(({ role, content }) => ({ role, content })));
    const systemContent = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    const userContent = messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
    return {
      cliVersion: profile.cliVersion,
      systemProfile: profile.systemProfile,
      frameworkHash: profile.frameworkHash,
      defaultSource: profile.defaultSource,
      defaultHash: profile.defaultHash,
      appendedHash: profile.appendedHash,
      effectiveHash: profile.effectiveHash,
      systemRequestHash: promptHash(systemContent),
      userRequestHash: promptHash(userContent),
      requestHash: promptHash(serialized),
    };
  }

  getCustomizationHistory(boardId: string): PromptCustomizationChange[] {
    return this.readStored(boardId).changes;
  }

  append(boardId: string, text: string): string {
    const addition = text.trim();
    if (!addition) throw new Error('Prompt text cannot be empty.');
    const stored = this.readStored(boardId);
    stored.appended = [stored.appended.trim(), addition].filter(Boolean).join('\n');
    stored.changes.push({ action: 'append', text: addition, createdAt: new Date().toISOString() });
    this.writeStored(stored);
    return stored.appended;
  }

  set(boardId: string, text: string): string {
    const replacement = text.trim();
    if (!replacement) throw new Error('Prompt text cannot be empty. Use /prompt clear to remove it.');
    const stored = this.readStored(boardId);
    stored.appended = replacement;
    stored.changes.push({ action: 'set', text: replacement, createdAt: new Date().toISOString() });
    this.writeStored(stored);
    return stored.appended;
  }

  clear(boardId: string): void {
    const stored = this.readStored(boardId);
    stored.appended = '';
    stored.changes.push({ action: 'clear', text: '', createdAt: new Date().toISOString() });
    this.writeStored(stored);
  }

  delete(boardId: string): void {
    rmSync(this.pathFor(boardId), { force: true });
  }

  auditStatus(board: BoardConfig, history: PromptHistoryEntry[]): PromptAuditStatus {
    const latest = [...history].reverse().find((entry) =>
      Array.isArray(entry.writtenFiles) && entry.writtenFiles.length > 0,
    );
    if (!latest) return { freshness: 'never-generated' };
    if (!latest.promptAudit) return { freshness: 'legacy', latest };
    const current = this.profile(board);
    const audit = latest.promptAudit;
    const matches = audit.frameworkHash === current.frameworkHash &&
      audit.defaultHash === current.defaultHash &&
      audit.effectiveHash === current.effectiveHash &&
      audit.appendedHash === current.appendedHash;
    return { freshness: matches ? 'current' : 'stale', latest };
  }

  summary(board: BoardConfig, history: PromptHistoryEntry[]): string {
    const profile = this.profile(board);
    const status = this.auditStatus(board, history);
    const latestAudit = status.latest?.promptAudit;
    return [
      `Prompt profile for ${board.title}`,
      `CLI: v${profile.cliVersion}`,
      `Framework: ${profile.systemProfile} (${shortHash(profile.frameworkHash)})`,
      `Default: ${profile.defaultSource} (${shortHash(profile.defaultHash)})`,
      `Appended: ${profile.appendedPrompt ? `${profile.appendedPrompt.length} chars (${shortHash(profile.appendedHash)})` : 'none'}`,
      `Effective: ${shortHash(profile.effectiveHash)}`,
      `Last successful generation: ${status.latest?.createdAt ?? 'none'}`,
      `Last generation CLI: ${latestAudit ? `v${latestAudit.cliVersion}` : 'not recorded'}`,
      `Status: ${status.freshness.toUpperCase()}`,
      '',
      'Use /prompt full to inspect the effective dashboard prompt.',
      'Use /prompt history for dated provenance and customization changes.',
      'Use /prompt append <text>, /prompt set <text>, or /prompt clear.',
      'Changes apply to the next LLM generation; run /update to regenerate now.',
    ].join('\n');
  }

  full(board: BoardConfig): string {
    const profile = this.profile(board);
    return [
      `Effective dashboard prompt for ${board.title}`,
      `Source: ${profile.defaultSource} | framework: ${profile.systemProfile} | CLI: v${profile.cliVersion}`,
      `Hashes: framework=${shortHash(profile.frameworkHash)} default=${shortHash(profile.defaultHash)} effective=${shortHash(profile.effectiveHash)}`,
      '',
      profile.effectivePrompt,
    ].join('\n');
  }

  historyReport(board: BoardConfig, history: PromptHistoryEntry[]): string {
    const generationLines = history.slice(-12).map((entry) => {
      const audit = entry.promptAudit;
      return audit
        ? `${entry.createdAt} [${entry.source}] CLI v${audit.cliVersion} effective=${shortHash(audit.effectiveHash)} request=${shortHash(audit.requestHash)}`
        : `${entry.createdAt} [${entry.source}] LEGACY/UNVERIFIABLE`;
    });
    const customizationLines = this.getCustomizationHistory(board.id).slice(-12).map((change) => {
      const preview = change.text.length > 100 ? `${change.text.slice(0, 97)}...` : change.text;
      return `${change.createdAt} [${change.action}] ${preview || '(default restored)'}`;
    });
    return [
      `Prompt provenance for ${board.title}`,
      '',
      'Successful generation history:',
      ...(generationLines.length > 0 ? generationLines : ['(none)']),
      '',
      'Customization history:',
      ...(customizationLines.length > 0 ? customizationLines : ['(none)']),
    ].join('\n');
  }
}

export default DashboardPromptService;
