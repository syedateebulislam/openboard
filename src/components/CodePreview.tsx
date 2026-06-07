/**
 * CodePreview — Renders a code block in the terminal with syntax highlighting hints.
 * Shows a bordered box with the file name and content lines.
 */
import React from 'react';
import { Box, Text } from 'ink';
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
  const lines = content.split('\n');
  const truncated = lines.length > maxLines;
  const visibleLines = truncated ? lines.slice(0, maxLines) : lines;

  const header = filename
    ? `${filename}${language ? ` (${language})` : ''}`
    : language ?? 'code';

  const borderWidth = Math.max(header.length + 4, 40);
  const borderLine = '─'.repeat(borderWidth);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* Header */}
      <Text color={UI_COLORS.border}>┌{borderLine}┐</Text>
      <Text color={UI_COLORS.border}>│ <Text color="white" bold>{header}</Text>{' '.repeat(borderWidth - header.length - 1)}│</Text>
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
