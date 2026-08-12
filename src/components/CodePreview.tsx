/**
 * CodePreview — Renders a code block in the terminal with syntax highlighting hints.
 * Shows a bordered box with the file name and content lines.
 */
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { UI_COLORS } from '../theme.js';

interface CodePreviewProps {
  /** Code content to display */
  content: string;
  /** Optional file name shown in the header */
  filename?: string;
  /** Language hint for display (no real syntax highlighting in terminal) */
  language?: string;
  /** Maximum number of lines to show (default: 20) */
  maxLines?: number;
}

export function CodePreview({ content, filename, language, maxLines = 20 }: CodePreviewProps) {
  const { stdout } = useStdout();
  const lines = content.split('\n');
  const truncated = lines.length > maxLines;
  const visibleLines = truncated ? lines.slice(0, maxLines) : lines;

  const header = filename
    ? `${filename}${language ? ` (${language})` : ''}`
    : language ?? 'code';

  // Bounded by the terminal, not only by the header. The width was
  // max(header + 4, 40) with no upper limit, so a long generated filename drew
  // a box wider than the window and every row of it wrapped — the frame broke
  // into a diagonal staircase. The -4 leaves room for the parent's padding.
  const terminalWidth = stdout?.columns ?? 80;
  const available = Math.max(20, terminalWidth - 4);
  const borderWidth = Math.min(Math.max(header.length + 4, 40), available);
  const borderLine = '─'.repeat(borderWidth);
  // The header is padded to borderWidth below, so it has to fit inside it too.
  const shownHeader = header.length > borderWidth - 2
    ? `${header.slice(0, Math.max(1, borderWidth - 5))}...`
    : header;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* Header */}
      <Text color={UI_COLORS.border}>┌{borderLine}┐</Text>
      <Text color={UI_COLORS.border}>│ <Text color="white" bold>{shownHeader}</Text>{' '.repeat(Math.max(0, borderWidth - shownHeader.length - 1))}│</Text>
      <Text color={UI_COLORS.border}>├{borderLine}┤</Text>

      {/* Code lines */}
      {visibleLines.map((line, i) => {
        const lineNum = String(i + 1).padStart(3, ' ');
        const paddedLine = line.length > borderWidth - 6
          ? line.substring(0, borderWidth - 9) + '...'
          : line;
        const padding = ' '.repeat(Math.max(0, borderWidth - paddedLine.length - 5));
        return (
          <Text key={i} color={UI_COLORS.border}>
            │ <Text color={UI_COLORS.subtitle}>{lineNum}</Text> <Text color="white">{paddedLine}</Text>{padding}│
          </Text>
        );
      })}

      {/* Truncation notice */}
      {truncated && (
        <Text color={UI_COLORS.border}>│ <Text color="yellow">... {lines.length - maxLines} more lines hidden ...</Text>{' '.repeat(Math.max(0, borderWidth - 30))}│</Text>
      )}

      {/* Footer */}
      <Text color={UI_COLORS.border}>└{borderLine}┘</Text>
    </Box>
  );
}

export default CodePreview;
