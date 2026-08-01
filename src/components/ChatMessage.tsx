/**
 * ChatMessage — Renders ONE line of the chat log in the TUI.
 *
 * The log is flattened to lines by `utils/chatViewport` before it reaches
 * here, so a row is already wrapped to the viewport width: rendering per line
 * (rather than per message) is what lets PgUp/PgDn land on an exact row and
 * lets the scrollbar thumb match what is on screen.
 */
import React, { memo } from 'react';
import { Text } from 'ink';
import type { ChatLine } from '../utils/chatViewport.js';
import type { ChatMessage as ChatMessageType } from '../types/board.js';

// System/status messages must not look like failures — reserve red for errors.
export const ROLE_COLORS: Record<ChatMessageType['role'], string> = {
  user: '#90EE90',
  assistant: '#FFD166',
  system: '#6EC5E9',
  error: 'red',
};

interface Props {
  line: ChatLine;
}

function ChatLineRowInner({ line }: Props) {
  return (
    <Text wrap="truncate-end">
      <Text color={ROLE_COLORS[line.role]} bold>{line.label}</Text>
      {line.text}
      {line.streaming ? '▋' : ''}
    </Text>
  );
}

// Memoize: rows are re-rendered on every streamed token, but only the tail
// line of the streaming message actually changes.
export const ChatLineRow = memo(ChatLineRowInner, (prev, next) => {
  return (
    prev.line.key === next.line.key &&
    prev.line.text === next.line.text &&
    prev.line.label === next.line.label &&
    prev.line.streaming === next.line.streaming
  );
});

export default ChatLineRow;
