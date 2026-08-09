/**
 * Phase 18 — the failures from the local LM Studio session.
 *
 * A 27B model on local hardware generates at ~16 tok/s. The OpenAI SDK defaults
 * to a 10-minute request timeout, which no provider overrode, so every long
 * generation was severed mid-answer and reported as malformed output. The
 * repair loop then resubmitted a byte-identical prompt and hit the same wall,
 * three times.
 *
 * Separately, the fetcher it was trying to build could never have worked: the
 * mailbox held forwarded receipts, and a FROM search cannot see those.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCAL_LLM_TIMEOUT_MS,
  isLocalBaseUrl,
  messageText,
  timeoutForBaseUrl,
} from '../../src/services/llm/OpenAICompatibleProvider.js';
import { describeLLMError } from '../../src/utils/errorCodes.js';
import { wasCutOff } from '../../src/services/billers/BillerScriptGenerator.js';
import { migrateFetcherSource, bundledScriptsDir } from '../../src/services/billers/BillerDiscoveryService.js';

// ── the timeout that caused it ───────────────────────────────────────────────

describe('local endpoints get a longer timeout', () => {
  it('recognises the addresses a local model server listens on', () => {
    for (const url of [
      'http://127.0.0.1:1234/v1',
      'http://localhost:1234/v1',
      'http://[::1]:11434/v1',
      'http://0.0.0.0:1234/v1',
      'http://my-box.local:1234/v1',
    ]) {
      expect(isLocalBaseUrl(url), url).toBe(true);
    }
  });

  it('treats hosted APIs as remote', () => {
    for (const url of [
      'https://api.x.ai/v1',
      'https://api.mistral.ai/v1',
      'https://openrouter.ai/api/v1',
      'https://api.openai.com/v1',
    ]) {
      expect(isLocalBaseUrl(url), url).toBe(false);
    }
  });

  it('is not fooled by a hosted domain that merely mentions localhost', () => {
    expect(isLocalBaseUrl('https://localhost.attacker.example/v1')).toBe(false);
    expect(isLocalBaseUrl('https://api.example.com/localhost')).toBe(false);
  });

  it('gives local servers a ceiling well past the SDK default', () => {
    // The SDK default of 600_000 ms is what cut the generation off.
    expect(timeoutForBaseUrl('http://127.0.0.1:1234/v1')).toBe(LOCAL_LLM_TIMEOUT_MS);
    expect(LOCAL_LLM_TIMEOUT_MS).toBeGreaterThan(600_000);
  });

  it('leaves hosted providers on the SDK default', () => {
    // undefined means "do not pass a timeout", so a hung cloud request still
    // surfaces as a fault in ten minutes rather than forty-five.
    expect(timeoutForBaseUrl('https://api.mistral.ai/v1')).toBeUndefined();
  });

  it('does not crash on an unparseable base URL', () => {
    expect(isLocalBaseUrl('not a url')).toBe(false);
    expect(timeoutForBaseUrl('not a url')).toBeUndefined();
  });
});

describe('timeout is explained', () => {
  it('tells the user retrying will take just as long', () => {
    // This is the message the session never got: four attempts, forty minutes,
    // and nothing saying the request had been cut rather than misformatted.
    const message = describeLLMError('Request timed out.', 'lmstudio');
    expect(message).toMatch(/timed out before the model finished/i);
    expect(message).toMatch(/retrying the same prompt will take just as long/i);
    expect(message).toContain('lmstudio');
  });

  it('still routes a refused connection to the connection message', () => {
    expect(describeLLMError('connect ECONNREFUSED 127.0.0.1:1234')).toMatch(/Could not reach/i);
  });
});

// ── a severed answer is not a content mistake ────────────────────────────────

describe('wasCutOff', () => {
  it('recognises both truncation messages parseGeneratedScript raises', () => {
    expect(wasCutOff('The script was cut off after 9000 characters — the model ran out of output budget before finishing parse().')).toBe(true);
    expect(wasCutOff('The script stops before its CLI entry point (463 characters) — it was cut off mid-file.')).toBe(true);
  });

  it('does not claim a prose reply was cut off', () => {
    // That one is worth retrying; a truncation is not.
    expect(wasCutOff('The model did not return a complete fetcher script.')).toBe(false);
    expect(wasCutOff('The model proposed no usable fields for this email.')).toBe(false);
  });
});

// ── a reasoning model that answers in the wrong field ────────────────────────

describe('messageText', () => {
  it('prefers content, leaving normal replies untouched', () => {
    expect(messageText({ content: 'the answer', reasoning_content: 'thinking' })).toBe('the answer');
  });

  it('falls back to reasoning_content when content is empty', () => {
    // Observed verbatim in the session log: content "" beside 4,603 reasoning
    // tokens, which read to OpenBoardCLI as a model that said nothing.
    expect(messageText({ content: '', reasoning_content: 'the answer' })).toBe('the answer');
    expect(messageText({ content: '   ', reasoning_content: 'the answer' })).toBe('the answer');
  });

  it('returns empty when neither field carries anything', () => {
    expect(messageText({ content: '' })).toBe('');
    expect(messageText({})).toBe('');
    expect(messageText(null)).toBe('');
    expect(messageText(undefined)).toBe('');
  });

  it('ignores a non-string reasoning field', () => {
    expect(messageText({ content: '', reasoning_content: { nested: true } })).toBe('');
  });
});

// ── forwarded mail ───────────────────────────────────────────────────────────

describe('forwarded receipts', () => {
  const dir = bundledScriptsDir();
  const fetchers = readdirSync(dir).filter((f) => f.endsWith('.py'));

  it('every bundled script can widen its search', () => {
    // A FROM search alone reported "No messages found" against a mailbox full
    // of forwarded receipts, and the skeleton is immutable, so no generated
    // fetcher could ever have recovered.
    for (const file of fetchers) {
      const source = readFileSync(join(dir, file), 'utf-8');
      if (!source.includes('def search_uids(')) continue;
      expect(source, file).toContain('def _search_uids(');
      expect(source, file).toContain('TEXT "{sender}"');
    }
  });

  it('tries the sender first, so a direct inbox is unaffected', () => {
    const source = readFileSync(join(dir, 'fetch_zomato.py'), 'utf-8');
    const fromAt = source.indexOf('FROM "{sender}"');
    const textAt = source.indexOf('TEXT "{sender}"');
    expect(fromAt).toBeGreaterThan(-1);
    expect(textAt).toBeGreaterThan(fromAt);
  });

  it('the probe searches the same way the generated fetcher will', () => {
    // Otherwise Studio samples an email the fetcher then cannot find.
    const probe = readFileSync(join(dir, 'probe_biller.py'), 'utf-8');
    expect(probe).toContain('def _search_uids(');
    expect(probe).toContain('TEXT "{sender}"');
  });
});

describe('migrating an already-installed fetcher', () => {
  const legacy = [
    'import json',
    'from typing import List',
    '',
    'CREDENTIALS_PATH = "x"',
    '',
    'def read_json(path) -> dict:',
    '    with open(path, "r", encoding="utf-8") as f:',
    '        return json.load(f)',
    '',
    '',
    'def search_uids(imap, sender_email: str, since_date: str) -> List[str]:',
    `    criteria = f'(FROM "{sender_email}" SINCE {since_date})'`,
    '    status, data = imap.uid("search", None, criteria)',
    '    if status != "OK" or not data or not data[0]:',
    '        return []',
    '    return [uid.decode() for uid in data[0].split()]',
    '',
    '',
    'def run(args):',
    '    credentials = read_json(CREDENTIALS_PATH)',
    '    return 0, 0',
    '',
  ].join('\n');

  it('applies the credentials and forwarded-mail upgrades together', () => {
    // They are independent migrations; an early return used to mean only the
    // first one ever ran.
    const migrated = migrateFetcherSource(legacy)!;
    expect(migrated).toContain('def load_credentials(');
    expect(migrated).toContain('credentials = load_credentials()');
    expect(migrated).toContain('def _search_uids(');
    expect(migrated).toContain('TEXT "{sender}"');
  });

  it('is idempotent, because it runs before every fetch', () => {
    const once = migrateFetcherSource(legacy)!;
    expect(migrateFetcherSource(once)).toBeUndefined();
  });

  it('preserves CRLF, so the diff is the change and nothing else', () => {
    const migrated = migrateFetcherSource(legacy.replaceAll('\n', '\r\n'))!;
    expect(/[^\r]\n/.test(migrated)).toBe(false);
  });

  it('upgrades the multi-sender variant too', () => {
    const multi = legacy.replace(
      /def search_uids[\s\S]*?return \[uid\.decode\(\) for uid in data\[0\]\.split\(\)\]\n/,
      [
        'def search_uids(imap, sender_email: str, since_date: str) -> List[str]:',
        '    sender_emails = sender_email if isinstance(sender_email, (list, tuple, set)) else [sender_email]',
        '    uids = set()',
        '    for sender in sender_emails:',
        `        criteria = f'(FROM "{sender}" SINCE {since_date})'`,
        '        status, data = imap.uid("search", None, criteria)',
        '        if status == "OK" and data and data[0]:',
        '            uids.update(uid.decode() for uid in data[0].split())',
        '    return sorted(uids, key=lambda value: int(value))',
        '',
      ].join('\n'),
    );
    const migrated = migrateFetcherSource(multi);
    expect(migrated).toBeTruthy();
    expect(migrated!).toContain('def _search_uids(');
  });
});
