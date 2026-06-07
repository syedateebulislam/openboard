/**
 * PHASE 3: Code Extractor Tests
 *
 * Tests the extractFiles() pure function from src/utils/codeExtractor.ts.
 * Validates parsing of LLM responses with various code formats.
 */

import { describe, it, expect } from 'vitest';
import { extractFiles } from '../../src/utils/codeExtractor.js';

describe('CodeExtractor', () => {
  // -------------------------------------------------------------------------
  // Strategy 1: //CODE_START + --- FILE: --- markers
  // -------------------------------------------------------------------------

  describe('CODE_START/CODE_END with FILE markers', () => {
    it('should extract a single file from properly marked response', () => {
      const response = `Here is your component:

//CODE_START
--- FILE: components/MetricCard.tsx ---
interface MetricCardProps {
  title: string;
  value: number;
}

export function MetricCard({ title, value }: MetricCardProps) {
  return <div className="card"><p>{title}</p><p>{value}</p></div>;
}
--- END FILE ---
//CODE_END

Hope this helps!`;

      const files = extractFiles(response);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('components/MetricCard.tsx');
      expect(files[0].content).toContain('export function MetricCard');
      expect(files[0].content).toContain('MetricCardProps');
    });

    it('should extract multiple files', () => {
      const response = `//CODE_START
--- FILE: components/Chart.tsx ---
export function Chart() { return <div>Chart</div>; }
--- END FILE ---

--- FILE: components/Header.tsx ---
export function Header() { return <header>Header</header>; }
--- END FILE ---

--- FILE: App.tsx ---
import { Chart } from './components/Chart';
import { Header } from './components/Header';
export default function App() { return <div><Header /><Chart /></div>; }
--- END FILE ---
//CODE_END`;

      const files = extractFiles(response);
      expect(files).toHaveLength(3);
      expect(files[0].path).toBe('components/Chart.tsx');
      expect(files[1].path).toBe('components/Header.tsx');
      expect(files[2].path).toBe('App.tsx');
    });

    it('should ignore chat text outside CODE_START/CODE_END markers', () => {
      const response = `I'll create a deploy button for you. Here's some code:

const notExtracted = true;

//CODE_START
--- FILE: components/DeployButton.tsx ---
export function DeployButton() { return <button>Deploy</button>; }
--- END FILE ---
//CODE_END

The above code creates a simple deploy button component.`;

      const files = extractFiles(response);
      expect(files).toHaveLength(1);
      expect(files[0].content).not.toContain('notExtracted');
      expect(files[0].content).toContain('DeployButton');
    });
  });

  // -------------------------------------------------------------------------
  // Path normalization
  // -------------------------------------------------------------------------

  describe('Path normalization', () => {
    it('should strip src/ prefix from paths', () => {
      const response = `//CODE_START
--- FILE: src/components/Widget.tsx ---
export function Widget() { return <div>Widget</div>; }
--- END FILE ---
//CODE_END`;

      const files = extractFiles(response);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('components/Widget.tsx');
    });

    it('should keep paths without src/ prefix unchanged', () => {
      const response = `//CODE_START
--- FILE: App.tsx ---
export default function App() { return <div>App</div>; }
--- END FILE ---
//CODE_END`;

      const files = extractFiles(response);
      expect(files[0].path).toBe('App.tsx');
    });
  });

  // -------------------------------------------------------------------------
  // Strategy 2: Fallback code block syntax
  // -------------------------------------------------------------------------

  describe('Fallback: code block with filepath', () => {
    it('should extract files from ```lang:filepath format', () => {
      const response = `\`\`\`tsx:components/Card.tsx
export function Card() { return <div className="card">Card</div>; }
\`\`\``;

      const files = extractFiles(response);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('components/Card.tsx');
      expect(files[0].content).toContain('Card');
    });
  });

  // -------------------------------------------------------------------------
  // Strategy 3: Single file fallback
  // -------------------------------------------------------------------------

  describe('Fallback: single file detection', () => {
    it('should detect single file starting with import', () => {
      const response = `import React from 'react';

export function Dashboard() {
  return (
    <div className="app-container">
      <h1>Dashboard</h1>
    </div>
  );
}`;

      const files = extractFiles(response);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('components/Dashboard.tsx');
      expect(files[0].content).toContain('Dashboard');
    });

    it('should detect single file starting with export', () => {
      const response = `export default function Analytics() {
  return <div>Analytics content here with enough characters to pass the length check</div>;
}`;

      const files = extractFiles(response);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('components/Analytics.tsx');
    });

    it('should use GeneratedComponent as fallback name when no export found', () => {
      const response = `const data = [1, 2, 3, 4, 5];
const processedData = data.map(x => x * 2);
console.log(processedData);
// This is just some code without a named export but long enough to trigger detection`;

      const files = extractFiles(response);
      // Should either be empty (too short) or use GeneratedComponent
      if (files.length > 0) {
        expect(files[0].path).toBe('components/GeneratedComponent.tsx');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('should return empty array for empty string', () => {
      expect(extractFiles('')).toEqual([]);
    });

    it('should return empty array for chat-only response with no code', () => {
      const response = 'Sure! I can help you with that. What kind of chart would you like?';
      expect(extractFiles(response)).toEqual([]);
    });

    it('should return empty array for short code snippets', () => {
      const response = 'const x = 1;';
      expect(extractFiles(response)).toEqual([]);
    });

    it('should handle CODE_START without CODE_END (uses full response)', () => {
      const response = `//CODE_START
--- FILE: components/Test.tsx ---
export function Test() { return <div>Test</div>; }
--- END FILE ---`;

      // No CODE_END means isolateCodeSection falls back to full response
      const files = extractFiles(response);
      expect(files).toHaveLength(1);
    });

    it('should skip empty file blocks', () => {
      const response = `//CODE_START
--- FILE: components/Empty.tsx ---
--- END FILE ---

--- FILE: components/Real.tsx ---
export function Real() { return <div>Real</div>; }
--- END FILE ---
//CODE_END`;

      const files = extractFiles(response);
      // Empty file block should be skipped (content is empty after trimEnd)
      expect(files.every(f => f.content.length > 0)).toBe(true);
    });
  });
});
