/**
 * StatusBadge — Colored status indicator for TUI feedback.
 * Shows success/error/warning/info with appropriate color and symbol.
 */
import React from 'react';
import { Text } from 'ink';

type StatusType = 'success' | 'error' | 'warning' | 'info' | 'pending';

interface StatusBadgeProps {
  status: StatusType;
  message: string;
}

const STATUS_CONFIG: Record<StatusType, { symbol: string; color: string }> = {
  success: { symbol: '✓', color: 'green' },
  error:   { symbol: '✗', color: 'red' },
  warning: { symbol: '⚠', color: 'yellow' },
  info:    { symbol: 'ℹ', color: 'blue' },
  pending: { symbol: '○', color: 'gray' },
};

export function StatusBadge({ status, message }: StatusBadgeProps) {
  const { symbol, color } = STATUS_CONFIG[status];
  return (
    <Text color={color as Parameters<typeof Text>[0]['color']}>
      {symbol} {message}
    </Text>
  );
}

export default StatusBadge;
