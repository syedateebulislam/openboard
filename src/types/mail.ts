/**
 * Shared types for the Gmail mail integration.
 *
 * MailRow is deliberately flat (primitives only) so the cached messages.json
 * parses through DataParserService/DataAnalyzer as a regular board data
 * source: `date` must stay YYYY-MM-DD to be detected as a date column, and
 * `labels` is a comma-joined string rather than an array.
 */

export interface GmailSettings {
  clientId?: string;
  clientSecret?: string;
  email?: string;
  /** Gmail search query for sync ticks. */
  query: string;
  syncIntervalMinutes: number;
  /** Max messages fetched per sync tick. */
  maxResults: number;
  needsReauth: boolean;
}

export const GMAIL_DEFAULT_QUERY = 'in:inbox';
export const GMAIL_DEFAULT_SYNC_INTERVAL_MINUTES = 5;
export const GMAIL_DEFAULT_MAX_RESULTS = 200;
/** First sync has no lastSyncAt watermark; pull a month and allow a bigger page. */
export const GMAIL_FIRST_SYNC_QUERY_SUFFIX = 'newer_than:30d';
export const GMAIL_FIRST_SYNC_MAX_RESULTS = 500;

export interface MailRow {
  id: string;
  threadId: string;
  date: string;
  time: string;
  from: string;
  fromAddress: string;
  fromDomain: string;
  subject: string;
  snippet: string;
  labels: string;
  category: string;
  unread: boolean;
  hasAttachment: boolean;
  sizeKb: number;
}

export interface MailSyncState {
  lastSyncAt?: string;
  lastSyncCount?: number;
  totalCached?: number;
  lastError?: string;
  lastHistoryId?: string;
}

export interface MailSyncResult {
  ok: boolean;
  fetched: number;
  totalCached: number;
  syncedAt: string;
  error?: string;
  needsReauth?: boolean;
}

export type MailSchedulerState =
  | 'idle'
  | 'syncing'
  | 'error'
  | 'needs-reauth'
  | 'not-configured';

export interface MailSchedulerStatus {
  state: MailSchedulerState;
  lastSyncAt?: string;
  nextSyncAt?: string;
  totalCached?: number;
  error?: string;
}
