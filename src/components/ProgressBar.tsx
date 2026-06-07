/**
 * ProgressBar — ASCII progress bar for the TUI.
 * Renders a filled/empty bar with percentage label.
 *
 * Example: ████████░░░░ 66%
 */
import React from 'react';
import { Box, Text } from 'ink';
import { UI_COLORS } from '../theme.js';

interface ProgressBarProps {
  /** Progress value between 0 and 100 */
  value: number;
  /** Total width of the bar in characters (default: 20) */
  width?: number;
  /** Color of the filled portion (default: 'green') */
  fillColor?: string;
  /** Color of the empty portion (default: 'gray') */
  emptyColor?: string;
  /** Show percentage label (default: true) */
  showPercent?: boolean;
  /** Optional label prefix */
  label?: string;
}

export function ProgressBar({
  value,
  width = 20,
  fillColor = 'green',
  emptyColor = UI_COLORS.subtitle,
  showPercent = true,
  label,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = width - filledCount;

  const filled = '█'.repeat(filledCount);
  const empty = '░'.repeat(emptyCount);

  return (
    <Box>
      {label && <Text>{label} </Text>}
      <Text color={fillColor as Parameters<typeof Text>[0]['color']}>{filled}</Text>
      <Text color={emptyColor as Parameters<typeof Text>[0]['color']}>{empty}</Text>
      {showPercent && <Text> {clamped}%</Text>}
    </Box>
  );
}

export default ProgressBar;
