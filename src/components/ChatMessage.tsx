/**
 * ChatMessage — Renders a chat message in the TUI.
 * Supports user/assistant/system/error message types with distinct colors.
 */
import React, { memo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage as ChatMessageType } from '../types/board.js';

// System/status messages must not look like failures — reserve red for errors.
const ROLE_CONFIG = {
  user:      { label: 'You', color: '#90EE90' },
  assistant: { label: 'LLM', color: '#FFD166' },
  system:    { label: 'Sys', color: '#6EC5E9' },
  error:     { label: 'Err', color: 'red'   as const },
};

// Max visible lines per message to prevent layout thrashing.
const DEFAULT_MAX_DISPLAY_LINES = 20;

interface Props {
  message: ChatMessageType;
  maxLines?: number;
}

/**
 * Truncate content to the last N lines for display.
 * Keeps the tail so the user always sees the latest output.
 */
function truncateForDisplay(content: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return { text: content, truncated: false };
  }
  return {
    text: '...\n' + lines.slice(-maxLines).join('\n'),
    truncated: true,
  };
}

function ChatMessageInner({ message, maxLines = DEFAULT_MAX_DISPLAY_LINES }: Props) {
  const config = ROLE_CONFIG[message.role];
  const { text } = truncateForDisplay(message.content, maxLines);

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color={config.color} bold>{config.label}: </Text>
        <Text wrap="wrap">{text}{message.isStreaming ? '▋' : ''}</Text>
      </Box>
    </Box>
  );
}

// Memoize: skip re-render if content and streaming state haven't changed
export const ChatMessageComponent = memo(ChatMessageInner, (prev, next) => {
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.isStreaming === next.message.isStreaming &&
    prev.maxLines === next.maxLines
  );
});

export default ChatMessageComponent;
