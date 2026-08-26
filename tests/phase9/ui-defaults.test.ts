/**
 * Phase 9 — UI default contracts shipped with every generation:
 *  - "Recent Records" is a useful default, not a mandatory output quota
 *  - equal-size KPI row rule + the CSS guard that enforces it
 *  - mobile header layout that keeps HeaderLinks clear of the user greeting
 *  - Excel support surfaced in the CLI help and creation screen
 *  - default models centralized in the shared catalog
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_PROMPT } from '../../src/services/llm/prompts/systemPrompt.js';
import { MASTER_DASHBOARD_PROMPT } from '../../src/config/dashboardPrompts.js';
import { DEFAULT_MODELS, defaultModelFor } from '../../src/config/llmCatalog.js';

const REPO = process.cwd();
const TEMPLATE_CSS = readFileSync(join(REPO, 'templates', 'dashboard', 'src', 'App.css'), 'utf-8');

describe('Recent Records table default', () => {
  it('keeps a practical newest-first table as an adaptive system default', () => {
    expect(SYSTEM_PROMPT).toContain('Recent Records');
    expect(SYSTEM_PROMPT).toMatch(/Usually end a data-exploration dashboard/i);
    expect(SYSTEM_PROMPT).toMatch(/newest first/i);
    expect(SYSTEM_PROMPT).toMatch(/sensible search\/sort and pagination/i);
    expect(SYSTEM_PROMPT).toContain('.data-table');
  });

  it('lets every category keep or simplify record inspection based on value', () => {
    for (const file of [
      'finance.md', 'grocery.md', 'custom.md', 'health.md', 'agent-default.md', 'fallback.md', 'master.md',
      'travel.md', 'food.md', 'shopping.md', 'subscriptions.md', 'utilities.md', 'invoices.md',
    ]) {
      const md = readFileSync(join(REPO, 'prompts', 'dashboard', file), 'utf-8');
      expect(md, file).toMatch(/record|table/i);
      expect(md, file).not.toMatch(/REQUIRED "Recent Records"/i);
    }
    expect(MASTER_DASHBOARD_PROMPT).toContain('Recent Records');
  });
});

describe('Equal-size KPI row', () => {
  it('is enforced in the system prompt', () => {
    expect(SYSTEM_PROMPT).toMatch(/KPI cards must be identical size/i);
    expect(SYSTEM_PROMPT).toMatch(/never make the first KPI span columns/i);
  });

  it('has a CSS guard so a KPI card can never span grid columns', () => {
    expect(TEMPLATE_CSS).toMatch(/\.grid-4 > \.kpi-card[\s\S]*?grid-column: span 1 !important/);
  });
});

describe('Mobile header layout', () => {
  it('splits the header into brand row + links/actions row on small screens', () => {
    const mobileBlock = TEMPLATE_CSS.slice(TEMPLATE_CSS.indexOf('Mobile shell adjustments'));
    expect(mobileBlock).toMatch(/\.app-brand \{ grid-column: 1 \/ -1; grid-row: 1; \}/);
    expect(mobileBlock).toMatch(/\.app-header-side\.app-header-actions \{ grid-column: 2; justify-self: end; \}/);
  });
});

describe('Excel support surfaces', () => {
  it('is mentioned in the CLI help and creation screen', () => {
    // Asserting the sentence verbatim made this a punctuation test — it broke on
    // an Oxford comma. What matters is that a user is told .xlsx works.
    for (const file of [['src', 'index.tsx'], ['src', 'screens', 'BoardCreationScreen.tsx']]) {
      const source = readFileSync(join(REPO, ...file), 'utf-8');
      expect(source, file.join('/')).toMatch(/\.csv[^\n]*\.xlsx[^\n]*\.json/);
    }
  });
});

describe('Default model centralization', () => {
  it('resolves known providers and falls back for unknown ones', () => {
    expect(defaultModelFor('anthropic')).toBe(DEFAULT_MODELS.anthropic);
    expect(defaultModelFor('moonshot')).toBe(DEFAULT_MODELS.moonshot);
    expect(defaultModelFor('nope')).toBe(DEFAULT_MODELS.openai);
  });

  it('leaves no stray per-file default-model maps outside the catalog', () => {
    for (const file of [
      join(REPO, 'src', 'services', 'project', 'DashboardUpdateService.ts'),
      join(REPO, 'src', 'screens', 'ChatScreen.tsx'),
      join(REPO, 'src', 'services', 'config', 'SetupService.ts'),
    ]) {
      const src = readFileSync(file, 'utf-8');
      expect(src, file).not.toMatch(/case 'moonshot':|DEFAULT_MODELS: Record/);
    }
  });
});
