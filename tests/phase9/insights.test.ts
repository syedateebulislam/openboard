/**
 * Phase 9 — default Top Insights block (spending & savings).
 *
 * Every dashboard renders a "Top Insights" panel of 3 shared <InsightCard>
 * tiles. For financial data these are the top 3 spending & savings insights.
 * The component ships in the template, is product-owned (synced into existing
 * workspaces), and the generation prompts require it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_PROMPT } from '../../src/services/llm/prompts/systemPrompt.js';
import { buildComponentGenerationPrompt } from '../../src/services/llm/prompts/componentGenerationPrompt.js';

const TEMPLATE = join(process.cwd(), 'templates', 'dashboard');

describe('Default Top Insights (spending & savings)', () => {
  it('ships an InsightCard component with tone + confidence', () => {
    const file = join(TEMPLATE, 'src', 'components', 'InsightCard.tsx');
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, 'utf-8');
    expect(src).toContain('confidence');
    expect(src).toMatch(/tone/);
    expect(src).toContain("'spend'");
    expect(src).toContain("'save'");
    expect(src).toContain('insight-item');
    expect(src).toMatch(/from 'lucide-react'/);
  });

  it('styles spend/save insight tones in the design system', () => {
    const css = readFileSync(join(TEMPLATE, 'src', 'App.css'), 'utf-8');
    expect(css).toContain('.insight-item--spend');
    expect(css).toContain('.insight-item--save');
    expect(css).toContain('.insight-title');
  });

  it('requires a Top Insights block with spending & savings, via InsightCard, and protects it', () => {
    expect(SYSTEM_PROMPT).toContain('Top Insights');
    expect(SYSTEM_PROMPT).toContain('InsightCard');
    expect(SYSTEM_PROMPT).toMatch(/SPENDING & SAVINGS/i);
    expect(SYSTEM_PROMPT).toContain('src/components/InsightCard.tsx'); // rule 20 protection

    const componentPrompt = buildComponentGenerationPrompt('Chart', 'test', 'type Row = {}', 'rows', '<div />');
    expect(componentPrompt).toContain('InsightCard');
    expect(componentPrompt).toMatch(/spending & savings/i);
  });

  it('keeps finance and grocery prompts focused on top 3 spending & savings insights', () => {
    for (const file of ['finance.md', 'grocery.md']) {
      const md = readFileSync(join(process.cwd(), 'prompts', 'dashboard', file), 'utf-8');
      expect(md).toMatch(/top 3 SPENDING & SAVINGS insights/i);
    }
  });
});
