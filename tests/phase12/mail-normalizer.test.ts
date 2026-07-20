/**
 * Phase 12 — Gmail integration: message normalization.
 *
 * MailRow feeds the board data pipeline unchanged, so the date format must
 * match DataAnalyzer's detection and all values must stay flat primitives.
 */

import { describe, it, expect } from 'vitest';
import {
  categoryFromLabels,
  normalizeMessage,
  parseAddress,
} from '../../src/services/mail/MailNormalizer.js';
import type { GmailMessageMetadata } from '../../src/services/mail/GmailClient.js';

// Mirrors DataAnalyzer's YYYY-MM-DD pattern (src/services/data/DataAnalyzer.ts).
const DATA_ANALYZER_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function message(overrides: Partial<GmailMessageMetadata> = {}): GmailMessageMetadata {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    snippet: 'Your order has shipped',
    labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
    internalDate: String(Date.UTC(2026, 6, 15, 9, 30)),
    sizeEstimate: 24_576,
    payload: {
      headers: [
        { name: 'From', value: '"Acme Shop" <orders@acme.com>' },
        { name: 'Subject', value: 'Order #123 shipped' },
        { name: 'Date', value: 'Wed, 15 Jul 2026 09:30:00 +0000' },
      ],
    },
    ...overrides,
  };
}

describe('parseAddress', () => {
  it('parses quoted display name with angle address', () => {
    expect(parseAddress('"Acme Shop" <Orders@Acme.com>')).toEqual({
      name: 'Acme Shop',
      address: 'orders@acme.com',
      domain: 'acme.com',
    });
  });

  it('parses unquoted display name', () => {
    expect(parseAddress('Jane Doe <jane@corp.io>')).toEqual({
      name: 'Jane Doe',
      address: 'jane@corp.io',
      domain: 'corp.io',
    });
  });

  it('parses a bare address, using it as the display name', () => {
    expect(parseAddress('noreply@github.com')).toEqual({
      name: 'noreply@github.com',
      address: 'noreply@github.com',
      domain: 'github.com',
    });
  });

  it('handles missing or empty headers', () => {
    expect(parseAddress(undefined)).toEqual({ name: '', address: '', domain: '' });
    expect(parseAddress('  ')).toEqual({ name: '', address: '', domain: '' });
  });
});

describe('categoryFromLabels', () => {
  it('maps CATEGORY_* labels', () => {
    expect(categoryFromLabels(['INBOX', 'CATEGORY_PROMOTIONS'])).toBe('promotions');
    expect(categoryFromLabels(['CATEGORY_SOCIAL'])).toBe('social');
    expect(categoryFromLabels(['CATEGORY_PERSONAL'])).toBe('primary');
  });

  it('defaults inbox mail to primary and everything else to other', () => {
    expect(categoryFromLabels(['INBOX'])).toBe('primary');
    expect(categoryFromLabels(['SENT'])).toBe('other');
  });
});

describe('normalizeMessage', () => {
  it('produces a flat row with a DataAnalyzer-compatible date', () => {
    const row = normalizeMessage(message());

    expect(row).toEqual({
      id: 'msg-1',
      threadId: 'thread-1',
      date: '2026-07-15',
      time: '09:30',
      from: 'Acme Shop',
      fromAddress: 'orders@acme.com',
      fromDomain: 'acme.com',
      subject: 'Order #123 shipped',
      snippet: 'Your order has shipped',
      labels: 'INBOX,UNREAD,CATEGORY_UPDATES',
      category: 'updates',
      unread: true,
      hasAttachment: false,
      sizeKb: 24,
    });
    expect(row.date).toMatch(DATA_ANALYZER_DATE_REGEX);
    for (const value of Object.values(row)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });

  it('falls back to the Date header when internalDate is missing', () => {
    const row = normalizeMessage(message({ internalDate: undefined }));
    expect(row.date).toBe('2026-07-15');
  });

  it('tolerates missing headers and snippet', () => {
    const row = normalizeMessage(message({ snippet: undefined, payload: { headers: [] } }));
    expect(row.subject).toBe('(no subject)');
    expect(row.snippet).toBe('');
    expect(row.from).toBe('');
  });
});
