/**
 * GmailClient — thin typed wrapper over the Gmail REST API using plain fetch.
 *
 * Auth is delegated to a getAccessToken callback (GmailAuthService); a 401
 * gets one retry after invalidating the cached token, then surfaces as a
 * reauth error. 429/5xx get one jittered retry.
 */

import { GmailReauthRequiredError } from './GmailAuthService.js';

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date'];
const MESSAGE_FETCH_CONCURRENCY = 5;
const RETRY_BASE_DELAY_MS = 750;

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailMessageMetadata {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  sizeEstimate?: number;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
}

export interface GmailProfile {
  emailAddress?: string;
  historyId?: string;
}

interface ListMessagesResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
}

export interface GmailClientDeps {
  getAccessToken: () => Promise<string>;
  invalidateAccessToken?: () => void;
  fetchImpl?: typeof fetch;
  /** Test hook — skips the real retry delay. */
  delayImpl?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GmailClient {
  private readonly getAccessToken: () => Promise<string>;
  private readonly invalidateAccessToken: () => void;
  private readonly fetchImpl: typeof fetch;
  private readonly delayImpl: (ms: number) => Promise<void>;

  constructor(deps: GmailClientDeps) {
    this.getAccessToken = deps.getAccessToken;
    this.invalidateAccessToken = deps.invalidateAccessToken ?? (() => {});
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.delayImpl = deps.delayImpl ?? sleep;
  }

  /** List message ids matching a Gmail search query, paginating up to maxResults. */
  async listMessages(query: string, maxResults: number): Promise<GmailMessageRef[]> {
    const refs: GmailMessageRef[] = [];
    let pageToken: string | undefined;
    while (refs.length < maxResults) {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.min(maxResults - refs.length, 100)),
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.request<ListMessagesResponse>(`${API_BASE}/messages?${params.toString()}`);
      refs.push(...(page.messages ?? []));
      pageToken = page.nextPageToken;
      if (!pageToken || (page.messages ?? []).length === 0) break;
    }
    return refs.slice(0, maxResults);
  }

  /** Fetch metadata (headers, snippet, labels) for one message. */
  async getMessage(id: string): Promise<GmailMessageMetadata> {
    const params = new URLSearchParams({ format: 'metadata' });
    for (const header of METADATA_HEADERS) params.append('metadataHeaders', header);
    return this.request<GmailMessageMetadata>(`${API_BASE}/messages/${id}?${params.toString()}`);
  }

  /** Fetch metadata for many messages with bounded concurrency, preserving order. */
  async getMessages(refs: GmailMessageRef[]): Promise<GmailMessageMetadata[]> {
    const results: GmailMessageMetadata[] = new Array(refs.length);
    let next = 0;
    const worker = async () => {
      while (next < refs.length) {
        const index = next++;
        results[index] = await this.getMessage(refs[index].id);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MESSAGE_FETCH_CONCURRENCY, refs.length) }, worker),
    );
    return results;
  }

  async getProfile(): Promise<GmailProfile> {
    return this.request<GmailProfile>(`${API_BASE}/profile`);
  }

  private async request<T>(url: string, attempt = 0): Promise<T> {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      if (attempt === 0) {
        // Stale access token — drop it and retry once with a fresh refresh.
        this.invalidateAccessToken();
        return this.request<T>(url, attempt + 1);
      }
      throw new GmailReauthRequiredError();
    }

    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      await this.delayImpl(RETRY_BASE_DELAY_MS + Math.floor(Math.random() * 500));
      return this.request<T>(url, attempt + 1);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gmail API error (HTTP ${response.status}): ${body.slice(0, 200)}`);
    }
    return await response.json() as T;
  }
}
