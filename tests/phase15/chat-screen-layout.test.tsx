/**
 * Phase 15 — ChatScreen layout budget.
 *
 * The chat log is sized by subtracting CHROME_ROWS from the terminal height.
 * If that constant ever drifts below what the surrounding chrome really costs,
 * the screen grows taller than the terminal and the whole fixed layout starts
 * scrolling away — a failure that is invisible in unit tests of the maths.
 * This renders the real screen at a known terminal size and checks it fits.
 *
 * Raw-mode input is stubbed out: ink-testing-library's fake stdin has no
 * ref/unref, so TextInput and useInput cannot mount under it. Neither takes
 * part in layout.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { BoardConfig, ChatMessage } from '../../src/types/board.js';

const TERM_ROWS = 30;
const TERM_COLS = 100;

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useStdout: () => ({ stdout: { rows: TERM_ROWS, columns: TERM_COLS }, write: () => {} }),
    useInput: () => {},
  };
});

vi.mock('ink-text-input', async () => {
  const { Text } = await vi.importActual<typeof import('ink')>('ink');
  const react = await vi.importActual<typeof import('react')>('react');
  return {
    default: ({ value, placeholder }: { value: string; placeholder?: string }) =>
      react.createElement(Text, null, value || placeholder || ''),
  };
});

const { ChatScreen } = await import('../../src/screens/ChatScreen.js');

const board = { id: 'b1', name: 'Test Board', type: 'custom', status: 'draft' } as unknown as BoardConfig;

function longHistory(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 ? 'assistant' : 'user') as ChatMessage['role'],
    content: `message ${i} ${'lorem ipsum dolor sit amet '.repeat(3)}`,
    timestamp: 0,
  }));
}

async function frameOf(messages: ChatMessage[]): Promise<string[]> {
  const { lastFrame, unmount } = render(<ChatScreen board={board} messages={messages} />);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const frame = lastFrame() ?? '';
  unmount();
  // eslint-disable-next-line no-control-regex
  return frame.split('\n').map((line) => line.replace(/\[[0-9;]*m/g, ''));
}

describe('ChatScreen layout', () => {
  it('should_fit_within_the_terminal_when_history_is_long', async () => {
    const lines = await frameOf(longHistory(40));
    expect(lines.length).toBeLessThanOrEqual(TERM_ROWS);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(TERM_COLS);
    }
  });

  it('should_frame_the_whole_screen_including_header_and_footer', async () => {
    const lines = await frameOf(longHistory(40));
    expect(lines[0].startsWith('╭')).toBe(true);
    expect(lines[lines.length - 1].startsWith('╰')).toBe(true);
    const framed = lines.slice(1, -1).every((line) => line.startsWith('│') && line.endsWith('│'));
    expect(framed).toBe(true);
  });

  it('should_draw_a_scrollbar_thumb_when_history_overflows', async () => {
    const lines = await frameOf(longHistory(40));
    expect(lines.some((line) => line.includes('█'))).toBe(true);
    expect(lines.some((line) => line.includes('░'))).toBe(true);
  });

  it('should_show_the_newest_message_when_pinned_to_the_bottom', async () => {
    const lines = await frameOf(longHistory(40));
    expect(lines.some((line) => line.includes('message 39'))).toBe(true);
  });

  it('should_keep_the_layout_stable_when_the_log_is_nearly_empty', async () => {
    const lines = await frameOf(longHistory(1));
    expect(lines.length).toBeLessThanOrEqual(TERM_ROWS);
    expect(lines.some((line) => line.includes('█'))).toBe(true);
  });
});
