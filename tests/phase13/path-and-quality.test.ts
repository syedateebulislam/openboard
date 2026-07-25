/**
 * PHASE 13: quoted-path normalization + low-quality UI mode plumbing.
 *
 * - normalizeUserPath: accepts a pasted path with or without surrounding
 *   quotes (Windows Explorer's "Copy as path" wraps paths in double quotes).
 * - BoardConfig.uiQuality round-trips through BoardRegistryService storage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUserPath } from '../../src/utils/pathNormalizer.js';
import { BoardRegistryService } from '../../src/services/project/BoardRegistryService.js';
import { ConfigService } from '../../src/services/config/ConfigService.js';
import type { BoardConfig } from '../../src/types/board.js';

describe('normalizeUserPath', () => {
  it('strips matching double quotes', () => {
    expect(normalizeUserPath('"C:\\Users\\me\\data.csv"')).toBe('C:\\Users\\me\\data.csv');
  });

  it('strips matching single quotes', () => {
    expect(normalizeUserPath("'/home/me/data.csv'")).toBe('/home/me/data.csv');
  });

  it('leaves an unquoted path untouched', () => {
    expect(normalizeUserPath('C:\\Users\\me\\data.csv')).toBe('C:\\Users\\me\\data.csv');
  });

  it('trims surrounding whitespace, including around quotes', () => {
    expect(normalizeUserPath('  "C:\\data.csv"  ')).toBe('C:\\data.csv');
  });

  it('does not strip mismatched quote characters', () => {
    expect(normalizeUserPath('"C:\\data.csv\'')).toBe('"C:\\data.csv\'');
  });

  it('does not strip a single leading or trailing quote alone', () => {
    expect(normalizeUserPath('"C:\\data.csv')).toBe('"C:\\data.csv');
    expect(normalizeUserPath('C:\\data.csv"')).toBe('C:\\data.csv"');
  });

  it('handles an empty or whitespace-only string', () => {
    expect(normalizeUserPath('')).toBe('');
    expect(normalizeUserPath('   ')).toBe('');
  });
});

describe('BoardConfig.uiQuality persistence', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openboard-board-registry-'));
  });

  afterEach(() => {
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  function makeBoard(overrides: Partial<BoardConfig> = {}): BoardConfig {
    return {
      id: 'board-1',
      name: 'sales',
      title: 'Sales',
      type: 'finance',
      outputDir: '',
      dataFiles: [],
      components: [],
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('round-trips uiQuality: "low" through storage', () => {
    const registry = new BoardRegistryService(new ConfigService(configDir));
    registry.upsertBoard(makeBoard({ uiQuality: 'low' }));

    const reloaded = new BoardRegistryService(new ConfigService(configDir)).listBoards();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].uiQuality).toBe('low');
  });

  it('leaves uiQuality undefined for boards created without it (backward compatible)', () => {
    const registry = new BoardRegistryService(new ConfigService(configDir));
    registry.upsertBoard(makeBoard());

    const reloaded = new BoardRegistryService(new ConfigService(configDir)).listBoards();
    expect(reloaded[0].uiQuality).toBeUndefined();
  });
});
