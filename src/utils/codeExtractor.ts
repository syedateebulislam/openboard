/**
 * codeExtractor — Parses LLM responses to extract file blocks.
 *
 * The LLM is instructed to wrap all code between boundary markers:
 *   //CODE_START
 *   --- FILE: relative/path/File.tsx ---
 *   <file content>
 *   --- END FILE ---
 *   //CODE_END
 *
 * This ensures only code (not chat text) is extracted and written to files.
 */

export interface ExtractedFile {
  /** Relative path from project src/ (e.g., "components/HealthChart.tsx" or "App.tsx") */
  path: string;
  /** File content */
  content: string;
}

/**
 * Extract the code section from an LLM response.
 * Returns only the content between //CODE_START and //CODE_END markers.
 * Falls back to the full response if markers are not found.
 */
function isolateCodeSection(response: string): string {
  const startMarker = '//CODE_START';
  const endMarker = '//CODE_END';

  const startIdx = response.indexOf(startMarker);
  const endIdx = response.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return response.slice(startIdx + startMarker.length, endIdx).trim();
  }

  // Fallback: no boundary markers found, use the full response
  return response;
}

/**
 * Extract file blocks from an LLM response string.
 * First isolates the code section (between //CODE_START and //CODE_END),
 * then parses --- FILE: ... --- blocks within it.
 * Returns an array of extracted files (may be empty if no file markers found).
 */
export function extractFiles(response: string): ExtractedFile[] {
  const codeSection = isolateCodeSection(response);
  const files: ExtractedFile[] = [];

  // Strategy 1: --- FILE: path --- ... --- END FILE ---
  const fileBlockRegex = /---\s*FILE:\s*(.+?)\s*---\n([\s\S]*?)---\s*END FILE\s*---/g;
  let match: RegExpExecArray | null;

  while ((match = fileBlockRegex.exec(codeSection)) !== null) {
    const path = match[1].trim();
    const content = match[2].trimEnd();
    if (path && content) {
      files.push({ path: normalizePath(path), content });
    }
  }

  if (files.length > 0) return files;

  // Strategy 2: ```lang:filepath\n...\n``` (fallback for non-compliant LLMs)
  const codeBlockRegex = /```\w*:([^\n]+)\n([\s\S]*?)```/g;

  while ((match = codeBlockRegex.exec(codeSection)) !== null) {
    const path = match[1].trim();
    const content = match[2].trimEnd();
    if (path && content) {
      files.push({ path: normalizePath(path), content });
    }
  }

  if (files.length > 0) return files;

  // Strategy 3: Single file — only if the code section looks like pure code
  const trimmed = codeSection.trim();
  if (
    trimmed.length > 50 &&
    (trimmed.startsWith('import ') ||
      trimmed.startsWith('export ') ||
      trimmed.startsWith('const ') ||
      trimmed.startsWith('function ') ||
      trimmed.startsWith("'use client'") ||
      trimmed.startsWith('"use client"'))
  ) {
    const componentMatch = trimmed.match(
      /export\s+(?:default\s+)?function\s+(\w+)|export\s+default\s+(\w+)/,
    );
    const name = componentMatch?.[1] || componentMatch?.[2] || 'GeneratedComponent';
    files.push({ path: `components/${name}.tsx`, content: trimmed });
  }

  return files;
}

/**
 * Strip "src/" prefix if present (TemplateService.writeGeneratedFile adds it).
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/^src\//, '');
}
