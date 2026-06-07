/**
 * PHASE 6: Board Presets Tests
 *
 * Tests pure functions from boardPresets.ts:
 * getPreset, getAvailablePresets, sanitizeBoardName, createBoardConfig.
 */

import { describe, it, expect } from 'vitest';
import {
  BOARD_PRESETS,
  getPreset,
  getAvailablePresets,
  sanitizeBoardName,
  createBoardConfig,
} from '../../src/config/boardPresets.js';

describe('Board Presets', () => {
  describe('Preset Configuration', () => {
    it('should define Health, Finance, Grocery, and Custom presets', () => {
      const presets = getAvailablePresets();
      const ids = presets.map(p => p.id);
      expect(ids).toContain('health');
      expect(ids).toContain('finance');
      expect(ids).toContain('grocery');
      expect(ids).toContain('custom');
      expect(presets).toHaveLength(4);
    });

    it('should have name, icon, description, defaultPrompt, and dataHints for each preset', () => {
      const presets = getAvailablePresets();
      for (const preset of presets) {
        expect(preset.name).toBeTruthy();
        expect(preset.icon).toBeTruthy();
        expect(preset.description).toBeTruthy();
        expect(preset.dataHints).toBeDefined();
        expect(typeof preset.defaultPrompt).toBe('string');
      }
    });

    it('should have finance preset with spending/income analytics prompt', () => {
      const finance = getPreset('finance');
      expect(finance.defaultPrompt).toMatch(/spending|income|categor|trend/i);
    });

    it('should have health preset with steps, heart_rate, sleep data hints', () => {
      const health = getPreset('health');
      expect(health.dataHints).toContain('steps');
      expect(health.dataHints).toContain('heart_rate');
      expect(health.dataHints).toContain('sleep_hours');
    });

    it('should have custom preset with empty defaults', () => {
      const custom = getPreset('custom');
      expect(custom.defaultPrompt).toBe('');
      expect(custom.dataHints).toEqual([]);
    });

    it('should throw for unknown preset id', () => {
      expect(() => getPreset('nonexistent')).toThrow(/Unknown preset/);
    });

    it('should return the same array as BOARD_PRESETS', () => {
      expect(getAvailablePresets()).toBe(BOARD_PRESETS);
    });
  });

  describe('Board Naming', () => {
    it('should sanitize board name to slug format', () => {
      expect(sanitizeBoardName('My Finance Board')).toBe('my-finance-board');
      expect(sanitizeBoardName('  spaces  everywhere  ')).toBe('spaces-everywhere');
    });

    it('should strip non-alphanumeric characters except hyphens and spaces', () => {
      expect(sanitizeBoardName('Hello! World@2025#')).toBe('hello-world2025');
    });

    it('should reject empty board name', () => {
      expect(() => sanitizeBoardName('')).toThrow(/required/i);
      expect(() => sanitizeBoardName('   ')).toThrow(/required/i);
    });

    it('should collapse consecutive hyphens', () => {
      expect(sanitizeBoardName('a---b')).toBe('a-b');
    });

    it('should strip leading/trailing hyphens', () => {
      expect(sanitizeBoardName('-hello-')).toBe('hello');
    });

    it('should preserve original input as board title', () => {
      const board = createBoardConfig('My Finance Board');
      expect(board.name).toBe('my-finance-board');
      expect(board.title).toBe('My Finance Board');
    });

    it('should reject empty name in createBoardConfig', () => {
      expect(() => createBoardConfig('')).toThrow(/required/i);
      expect(() => createBoardConfig('   ')).toThrow(/required/i);
    });
  });
});
