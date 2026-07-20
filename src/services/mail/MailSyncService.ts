/**
 * MailSyncService — one sync tick: query Gmail, normalize, merge into the
 * local cache, record sync state.
 *
 * Never throws to callers (the scheduler runs unattended): failures land in
 * sync-state.json and in the returned result, with needsReauth flagged for
 * revoked credentials so the scheduler can stop cleanly.
 *
 * Incremental strategy (v1): the user's query plus an `after:` watermark from
 * the previous sync, overlapped by one hour; cache-level dedupe by message id
 * makes the overlap harmless. First sync pulls `newer_than:30d`. historyId is
 * recorded in sync-state for a future users.history.list optimization
 * (history ids expire after ~a week, so v1 skips that complexity).
 */

import {
  GMAIL_FIRST_SYNC_MAX_RESULTS,
  GMAIL_FIRST_SYNC_QUERY_SUFFIX,
  type GmailSettings,
  type MailSyncResult,
} from '../../types/mail.js';
import { GmailAuthService, GmailReauthRequiredError } from './GmailAuthService.js';
import { GmailClient } from './GmailClient.js';
import { MailCacheService } from './MailCacheService.js';
import { normalizeMessage } from './MailNormalizer.js';
import { TypedConfigRepository } from '../config/TypedConfigRepository.js';

const SYNC_OVERLAP_MS = 60 * 60 * 1000;

export interface MailSyncDeps {
  auth?: GmailAuthService;
  client?: GmailClient;
  cache?: MailCacheService;
  settings?: () => GmailSettings;
}

export class MailSyncService {
  private readonly auth: GmailAuthService;
  private readonly client: GmailClient;
  private readonly cache: MailCacheService;
  private readonly settings: () => GmailSettings;

  constructor(deps: MailSyncDeps = {}) {
    this.auth = deps.auth ?? new GmailAuthService();
    this.client = deps.client ?? new GmailClient({
      getAccessToken: () => this.auth.getAccessToken(),
      invalidateAccessToken: () => this.auth.invalidateAccessToken(),
    });
    this.cache = deps.cache ?? new MailCacheService();
    this.settings = deps.settings ?? (() => new TypedConfigRepository().getGmailSettings());
  }

  buildQuery(baseQuery: string, lastSyncAt: string | undefined): string {
    if (!lastSyncAt) return `${baseQuery} ${GMAIL_FIRST_SYNC_QUERY_SUFFIX}`.trim();
    const watermark = new Date(lastSyncAt).getTime();
    if (!Number.isFinite(watermark)) return `${baseQuery} ${GMAIL_FIRST_SYNC_QUERY_SUFFIX}`.trim();
    const afterSeconds = Math.floor((watermark - SYNC_OVERLAP_MS) / 1000);
    return `${baseQuery} after:${Math.max(afterSeconds, 0)}`.trim();
  }

  async sync(): Promise<MailSyncResult> {
    const syncedAt = new Date().toISOString();
    try {
      const settings = this.settings();
      const state = this.cache.readSyncState();
      const firstSync = !state.lastSyncAt;
      const query = this.buildQuery(settings.query, state.lastSyncAt);
      const maxResults = firstSync
        ? Math.max(settings.maxResults, GMAIL_FIRST_SYNC_MAX_RESULTS)
        : settings.maxResults;

      const refs = await this.client.listMessages(query, maxResults);
      const messages = await this.client.getMessages(refs);
      const rows = messages.map(normalizeMessage);
      const totalCached = rows.length > 0
        ? this.cache.upsertMessages(rows)
        : this.cache.readMessages().length;

      let lastHistoryId = state.lastHistoryId;
      try {
        lastHistoryId = (await this.client.getProfile()).historyId ?? lastHistoryId;
      } catch {
        // Profile lookup is informational only.
      }

      this.cache.writeSyncState({
        lastSyncAt: syncedAt,
        lastSyncCount: rows.length,
        totalCached,
        lastHistoryId,
      });
      return { ok: true, fetched: rows.length, totalCached, syncedAt };
    } catch (error) {
      const needsReauth = error instanceof GmailReauthRequiredError;
      const message = error instanceof Error ? error.message : String(error);
      const state = this.cache.readSyncState();
      this.cache.writeSyncState({ ...state, lastError: message });
      return {
        ok: false,
        fetched: 0,
        totalCached: state.totalCached ?? this.cache.readMessages().length,
        syncedAt,
        error: message,
        needsReauth,
      };
    }
  }
}
