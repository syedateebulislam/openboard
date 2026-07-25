/**
 * Phase 12 — Gmail integration: /mail chat command parsing.
 */

import { describe, it, expect } from 'vitest';
import {
  CHAT_COMMANDS,
  HELP_TEXT,
  chatCommandsForMode,
  parseCommand,
} from '../../src/utils/commandParser.js';

describe('/mail command parsing', () => {
  it('parses /mail with and without args', () => {
    expect(parseCommand('/mail')).toEqual({ type: 'mail', args: [] });
    expect(parseCommand('/mail sync')).toEqual({ type: 'mail', args: ['sync'] });
    expect(parseCommand('/mail use')).toEqual({ type: 'mail', args: ['use'] });
    expect(parseCommand('  /MAIL SYNC  ')).toEqual({ type: 'mail', args: ['SYNC'] });
  });

  it('is listed in the command palette and help in every mode', () => {
    expect(CHAT_COMMANDS.some((c) => c.command === '/mail')).toBe(true);
    expect(chatCommandsForMode(false).some((c) => c.command === '/mail')).toBe(true);
    expect(HELP_TEXT).toContain('/mail');
  });

  it('does not swallow other slash commands', () => {
    expect(parseCommand('/mailbox').type).toBe('unknown');
    expect(parseCommand('/model')).toEqual({ type: 'model', args: [] });
  });
});
