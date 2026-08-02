/**
 * Phase 9 — consistent per-dashboard header strip.
 *
 * Every dashboard tab renders <DashboardHeader> (name left; total rows fetched
 * + last-updated time right). It ships in the template, is a product-owned
 * shell file (synced into existing workspaces), and the generation prompts
 * require it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_PROMPT } from '../../src/services/llm/prompts/systemPrompt.js';
import { buildComponentGenerationPrompt } from '../../src/services/llm/prompts/componentGenerationPrompt.js';

const TEMPLATE = join(process.cwd(), 'templates', 'dashboard');

describe('Dashboard header strip', () => {
  it('ships a DashboardHeader component fed by row count + generatedAt', () => {
    const file = join(TEMPLATE, 'src', 'components', 'DashboardHeader.tsx');
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, 'utf-8');
    expect(src).toContain('rowCount');
    expect(src).toContain('generatedAt');
    expect(src).toContain('className="dashboard-header"');
    // No new dependencies — only the project's existing libs.
    expect(src).toMatch(/from 'lucide-react'/);
    expect(src).toMatch(/from 'date-fns'/);
  });

  it('defines the header strip classes in the design system', () => {
    const css = readFileSync(join(TEMPLATE, 'src', 'App.css'), 'utf-8');
    for (const cls of ['.dashboard-header', '.dashboard-header-title', '.dashboard-header-meta', '.dashboard-meta-item']) {
      expect(css).toContain(cls);
    }
  });

  it('instructs the LLM to start every dashboard with DashboardHeader and protects it', () => {
    expect(SYSTEM_PROMPT).toContain('DashboardHeader');
    expect(SYSTEM_PROMPT).toContain('rowCount={data?.rows?.length}');
    expect(SYSTEM_PROMPT).toContain('generatedAt={data?.generatedAt}');
    // Protected from removal (rule 20).
    expect(SYSTEM_PROMPT).toContain('src/components/DashboardHeader.tsx');

    const componentPrompt = buildComponentGenerationPrompt('Chart', 'test', 'type Row = {}', 'rows', '<div />');
    expect(componentPrompt).toContain('DashboardHeader');
  });

  it('never teaches the unguarded rows access', () => {
    // `data?.rows.length` type-checks — the `?.` short-circuits the whole chain
    // for the compiler — but at run time it only short-circuits when `data`
    // itself is nullish. A payload that arrives without `rows` throws "Cannot
    // read properties of undefined (reading 'length')" and the tab dies while
    // every other tab keeps working. The prompt used to hand the model exactly
    // that form, so every dashboard it wrote inherited the hazard.
    const sources = [
      SYSTEM_PROMPT,
      buildComponentGenerationPrompt('Chart', 'test', 'type Row = {}', 'rows', '<div />'),
      readFileSync(join(TEMPLATE, 'src', 'components', 'DashboardHeader.tsx'), 'utf-8'),
    ];
    for (const source of sources) {
      expect(source).not.toMatch(/data\?\.rows\.length/);
    }
  });
});
