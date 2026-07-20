/**
 * MailNormalizer — pure mapping from Gmail message metadata to flat MailRow
 * records that parse cleanly through DataParserService/DataAnalyzer.
 *
 * Constraints that shape the output: `date` must be YYYY-MM-DD (DataAnalyzer's
 * date detection), every value must be a flat primitive (labels joined to a
 * string), and low-cardinality fields (category, fromDomain) are the ones the
 * generated dashboards chart.
 */

import type { MailRow } from '../../types/mail.js';
import type { GmailMessageMetadata } from './GmailClient.js';

const CATEGORY_LABEL_MAP: Record<string, string> = {
  CATEGORY_PERSONAL: 'primary',
  CATEGORY_PROMOTIONS: 'promotions',
  CATEGORY_SOCIAL: 'social',
  CATEGORY_UPDATES: 'updates',
  CATEGORY_FORUMS: 'forums',
};

export interface ParsedAddress {
  name: string;
  address: string;
  domain: string;
}

/** Parse an RFC 5322-ish From header: `"Display Name" <user@host>` or a bare address. */
export function parseAddress(header: string | undefined): ParsedAddress {
  const raw = (header ?? '').trim();
  if (!raw) return { name: '', address: '', domain: '' };

  const angleMatch = raw.match(/^(.*?)<([^<>]+)>\s*$/);
  const address = (angleMatch ? angleMatch[2] : raw).trim().toLowerCase();
  let name = angleMatch ? angleMatch[1].trim().replace(/^"(.*)"$/, '$1').trim() : '';
  if (!name) name = address;

  const atIndex = address.lastIndexOf('@');
  const domain = atIndex > 0 ? address.slice(atIndex + 1) : '';
  return { name, address, domain };
}

/** Map Gmail CATEGORY_* labels to a chart-friendly category; inbox mail defaults to primary. */
export function categoryFromLabels(labelIds: string[]): string {
  for (const label of labelIds) {
    const mapped = CATEGORY_LABEL_MAP[label];
    if (mapped) return mapped;
  }
  return labelIds.includes('INBOX') ? 'primary' : 'other';
}

function headerValue(message: GmailMessageMetadata, name: string): string | undefined {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** internalDate is epoch millis as a string; fall back to the Date header. */
function messageTimestamp(message: GmailMessageMetadata): Date {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0) return new Date(internal);
  const headerDate = new Date(headerValue(message, 'Date') ?? '');
  return Number.isNaN(headerDate.getTime()) ? new Date(0) : headerDate;
}

export function normalizeMessage(message: GmailMessageMetadata): MailRow {
  const labelIds = message.labelIds ?? [];
  const from = parseAddress(headerValue(message, 'From'));
  const timestamp = messageTimestamp(message);
  const iso = timestamp.toISOString();

  return {
    id: message.id,
    threadId: message.threadId,
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    from: from.name,
    fromAddress: from.address,
    fromDomain: from.domain,
    subject: headerValue(message, 'Subject') ?? '(no subject)',
    snippet: message.snippet ?? '',
    labels: labelIds.join(','),
    category: categoryFromLabels(labelIds),
    unread: labelIds.includes('UNREAD'),
    hasAttachment: labelIds.includes('HAS_ATTACHMENT'),
    sizeKb: Math.round((message.sizeEstimate ?? 0) / 1024),
  };
}
