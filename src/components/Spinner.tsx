/**
 * Spinner — Animated terminal spinner using ink-spinner.
 * Wraps InkSpinner with optional label text.
 */
import React from 'react';
import { Box, Text } from 'ink';
import InkSpinner from 'ink-spinner';
import { UI_COLORS } from '../theme.js';

interface SpinnerProps {
  /** Optional label shown next to the spinner */
  label?: string;
  /** Spinner type (default: 'dots') */
  type?: 'dots' | 'dots2' | 'dots3' | 'line' | 'pipe' | 'simpleDots' | 'star' | 'arc' | 'bounce';
  /** Color of the spinner (default: 'cyan') */
  color?: string;
}

export function Spinner({ label = 'Loading...', type = 'dots', color = UI_COLORS.logo }: SpinnerProps) {
  return (
    <Box>
      <Text color={color}>
        <InkSpinner type={type} />
      </Text>
      {label && (
        <Text color={color}>{' '}{label}</Text>
      )}
    </Box>
  );
}

export default Spinner;
