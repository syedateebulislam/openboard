/**
 * PHASE 4: Command Parsing Tests
 *
 * Tests the parseCommand() pure function from src/utils/commandParser.ts.
 * No mocking needed — pure input/output tests.
 */

import { describe, it, expect } from 'vitest';
import { parseCommand, HELP_TEXT, CHAT_COMMANDS, COMMANDS_TEXT, formatUnknownCommandMessage } from '../../src/utils/commandParser.js';

describe('Command Parsing', () => {
  // -------------------------------------------------------------------------
  // Command Detection
  // -------------------------------------------------------------------------

  describe('Command Detection', () => {
    it('should recognize "/deploy" as a deploy command', () => {
      expect(parseCommand('/deploy')).toEqual({ type: 'deploy' });
    });

    it('should not recognize old deploy aliases as commands', () => {
      expect(parseCommand('push to vercel')).toEqual({ type: 'message', text: 'push to vercel' });
      expect(parseCommand('deploy to vercel')).toEqual({ type: 'message', text: 'deploy to vercel' });
    });

    it('should recognize "/push" as git push command', () => {
      expect(parseCommand('/push')).toEqual({ type: 'push' });
    });

    it('should not recognize old push aliases as commands', () => {
      expect(parseCommand('push to github')).toEqual({ type: 'message', text: 'push to github' });
      expect(parseCommand('git push')).toEqual({ type: 'message', text: 'git push' });
    });

    it('should recognize "/build" as build command', () => {
      expect(parseCommand('/build')).toEqual({ type: 'build' });
    });

    it('should recognize "/update" as update command', () => {
      expect(parseCommand('/update')).toEqual({ type: 'update' });
    });

    it('should recognize "/preview" as preview command', () => {
      expect(parseCommand('/preview')).toEqual({ type: 'preview' });
    });

    it('should recognize /config slash command', () => {
      expect(parseCommand('/config')).toEqual({ type: 'config' });
    });

    it('should recognize /status slash command', () => {
      expect(parseCommand('/status')).toEqual({ type: 'status' });
    });

    it('should recognize /help slash command', () => {
      expect(parseCommand('/help')).toEqual({ type: 'help' });
    });

    it('should recognize utility slash commands', () => {
      expect(parseCommand('/commands')).toEqual({ type: 'commands' });
      expect(parseCommand('/doctor')).toEqual({ type: 'doctor' });
      expect(parseCommand('/history')).toEqual({ type: 'history' });
      expect(parseCommand('/logs')).toEqual({ type: 'logs' });
      expect(parseCommand('/data')).toEqual({ type: 'data' });
    });
  });

  // -------------------------------------------------------------------------
  // Command Properties
  // -------------------------------------------------------------------------

  describe('Command Properties', () => {
    it('should parse commands case-insensitively', () => {
      expect(parseCommand('/Deploy')).toEqual({ type: 'deploy' });
      expect(parseCommand('/DEPLOY')).toEqual({ type: 'deploy' });
      expect(parseCommand('/BUILD')).toEqual({ type: 'build' });
      expect(parseCommand('/UPDATE')).toEqual({ type: 'update' });
      expect(parseCommand('/Preview')).toEqual({ type: 'preview' });
      expect(parseCommand('/PUSH')).toEqual({ type: 'push' });
    });

    it('should trim whitespace from commands', () => {
      expect(parseCommand('  /deploy  ')).toEqual({ type: 'deploy' });
      expect(parseCommand('  /help  ')).toEqual({ type: 'help' });
      expect(parseCommand('\t/build\t')).toEqual({ type: 'build' });
    });

    it('should not detect commands embedded in natural language (exact match only)', () => {
      // parseCommand uses exact-match regex, so these are messages
      const result1 = parseCommand('deploy it to vercel now');
      expect(result1.type).toBe('message');

      const result2 = parseCommand('please push this to github');
      expect(result2.type).toBe('message');

      const result3 = parseCommand('can you build it');
      expect(result3.type).toBe('message');
    });
  });

  // -------------------------------------------------------------------------
  // Non-Command Routing
  // -------------------------------------------------------------------------

  describe('Non-Command Routing', () => {
    it('should route regular messages to LLM', () => {
      const result = parseCommand('add a pie chart showing spending by category');
      expect(result.type).toBe('message');
      expect(result).toEqual({ type: 'message', text: 'add a pie chart showing spending by category' });
    });

    it('should not treat incidental command words as commands', () => {
      const result = parseCommand('the deploy button should be red');
      expect(result.type).toBe('message');
    });

    it('should treat unknown slash commands as command errors with suggestions', () => {
      const result = parseCommand('/unknown');
      expect(result.type).toBe('unknown');
      expect(result).toMatchObject({ type: 'unknown', text: '/unknown' });
      if (result.type === 'unknown') {
        expect(result.suggestions.length).toBeGreaterThan(0);
      }
    });

    it('should format unknown command suggestions without routing to the LLM', () => {
      const parsed = parseCommand('/deply');
      expect(parsed.type).toBe('unknown');
      const message = parsed.type === 'unknown'
        ? formatUnknownCommandMessage(parsed.text, parsed.suggestions)
        : '';
      expect(message).toContain('Unknown command: /deply');
      expect(message).toContain('/deploy');
      expect(message).toContain('/help');
    });

    it('should preserve original text (trimmed) in message type', () => {
      const result = parseCommand('  hello world  ');
      expect(result).toEqual({ type: 'message', text: 'hello world' });
    });

    it('should handle empty string as message', () => {
      const result = parseCommand('');
      expect(result).toEqual({ type: 'message', text: '' });
    });
  });

  // -------------------------------------------------------------------------
  // HELP_TEXT
  // -------------------------------------------------------------------------

  describe('HELP_TEXT', () => {
    it('should list all supported commands', () => {
      expect(HELP_TEXT).toContain('/deploy');
      expect(HELP_TEXT).toContain('/push');
      expect(HELP_TEXT).toContain('/preview');
      expect(HELP_TEXT).toContain('Start or restart local preview server');
      expect(HELP_TEXT).not.toContain('Open local dev server in browser');
      expect(HELP_TEXT).toContain('/build');
      expect(HELP_TEXT).toContain('/update');
      expect(HELP_TEXT).toContain('/data');
      expect(HELP_TEXT).toContain('/history');
      expect(HELP_TEXT).toContain('/logs');
      expect(HELP_TEXT).toContain('/doctor');
      expect(HELP_TEXT).toContain('/commands');
      expect(HELP_TEXT).toContain('/config');
      expect(HELP_TEXT).toContain('/status');
      expect(HELP_TEXT).toContain('/help');
    });

    it('should expose command suggestions with categories and colors', () => {
      expect(CHAT_COMMANDS.length).toBeGreaterThan(8);
      expect(CHAT_COMMANDS.every((item) => item.command.startsWith('/'))).toBe(true);
      expect(CHAT_COMMANDS.find((item) => item.command === '/deploy')).toMatchObject({
        category: 'risky',
        color: 'yellow',
      });
      expect(CHAT_COMMANDS.find((item) => item.command === '/data')).toMatchObject({
        category: 'data',
        color: 'magenta',
      });
      expect(CHAT_COMMANDS.find((item) => item.command === '/logs')).toMatchObject({
        category: 'info',
      });
      expect(COMMANDS_TEXT).toContain('/commands');
      expect(COMMANDS_TEXT).toContain('[risky]');
      expect(COMMANDS_TEXT).toContain('[local]');
    });
  });
});
