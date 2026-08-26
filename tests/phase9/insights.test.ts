/**
 * Phase 9 — evidence-first Top Insights contract.
 *
 * InsightCard stays a product-owned visual primitive, while the generation
 * harness lets the model select only defensible findings instead of padding a
 * universal spending/saving quota.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_PROMPT } from '../../src/services/llm/prompts/systemPrompt.js';
import { buildComponentGenerationPrompt } from '../../src/services/llm/prompts/componentGenerationPrompt.js';

const TEMPLATE = join(process.cwd(), 'templates', 'dashboard');

describe('Evidence-first Top Insights', () => {
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

  it('requires adaptive, measured findings without a tone quota', () => {
    expect(SYSTEM_PROMPT).toContain('Top Insights');
    expect(SYSTEM_PROMPT).toContain('InsightCard');
    expect(SYSTEM_PROMPT).toMatch(/2-5 findings/i);
    expect(SYSTEM_PROMPT).toMatch(/render fewer rather than padding/i);
    expect(SYSTEM_PROMPT).toMatch(/comparison\/baseline/i);
    expect(SYSTEM_PROMPT).toMatch(/Never invent causality/i);
    expect(SYSTEM_PROMPT).toMatch(/no required split/i);
    expect(SYSTEM_PROMPT).toContain("from './InsightCard'");
    expect(SYSTEM_PROMPT).toContain('src/components/InsightCard.tsx'); // rule 20 protection
    expect(SYSTEM_PROMPT).not.toMatch(/exactly 4|top 2 SPENDING|top 2 SAVING/i);
    expect(SYSTEM_PROMPT).not.toContain('Largest savings opportunity');

    const componentPrompt = buildComponentGenerationPrompt('Chart', 'test', 'type Row = {}', 'rows', '<div />');
    expect(componentPrompt).toContain('InsightCard');
    expect(componentPrompt).toMatch(/2-5 <InsightCard>/i);
    expect(componentPrompt).toMatch(/render fewer instead of padding/i);
    expect(componentPrompt).toMatch(/Do not duplicate KPIs or invent causality/i);
    expect(componentPrompt).not.toMatch(/exactly 4|top 2 spending|top 2 saving/i);
  });

  it('keeps every category prompt evidence-gated and free of fixed insight quotas', () => {
    const files = [
      'agent-default.md', 'custom.md', 'fallback.md', 'finance.md', 'food.md',
      'grocery.md', 'health.md', 'invoices.md', 'master.md', 'shopping.md',
      'subscriptions.md', 'travel.md', 'utilities.md',
    ];
    for (const file of files) {
      const md = readFileSync(join(process.cwd(), 'prompts', 'dashboard', file), 'utf-8');
      expect(md, file).toMatch(/evidence-first Top Insights/i);
      expect(md, file).not.toMatch(/exactly 4|top 2 SPENDING|top 2 SAVING|2 spend \+ 2 save/i);
    }
  });

  it('blocks unsupported domain conclusions instead of seeding them as defaults', () => {
    const prompt = (name: string) => readFileSync(join(process.cwd(), 'prompts', 'dashboard', name), 'utf-8');
    expect(prompt('subscriptions.md')).toMatch(/Never call a subscription unused without usage data/i);
    expect(prompt('travel.md')).toMatch(/never infer surge pricing or off-peak savings/i);
    expect(prompt('health.md')).toMatch(/correlations as correlations, never diagnoses or causes/i);
    expect(prompt('grocery.md')).toMatch(/never project overspend without an explicit budget/i);
  });
});
