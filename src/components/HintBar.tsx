/**
 * HintBar — the one place key hints are worded.
 *
 * Nine different sentences for the same instruction had accumulated across the
 * screens ("Press ESC or select Go Back", "Use ↑↓ arrows to navigate, Enter to
 * select", "ESC to go back | PgUp/PgDn to scroll | /help for commands", …).
 * Each was written where it was needed, and together they read as nine
 * different applications.
 *
 * Hints are composed from named parts rather than typed as prose, so a screen
 * cannot invent a tenth phrasing without adding one here on purpose.
 */
import React from 'react';
import { Text } from 'ink';
import { UI_COLORS } from '../theme.js';

/** Every key hint the TUI is allowed to show, worded once. */
export const HINTS = {
  move: '↑↓ move',
  select: '⏎ select',
  continue: '⏎ continue',
  save: '⏎ save',
  toggle: '␣ toggle',
  remove: 'r remove',
  scroll: '⇞⇟ scroll',
  help: '? help',
  commands: '/help commands',
  back: 'esc back',
} as const;

export type HintKey = keyof typeof HINTS;

interface Props {
  /** Hints in reading order. `back` belongs last; callers rarely need to say so. */
  keys: HintKey[];
}

/**
 * Lowercase and dim on purpose: this is a reference strip, not an instruction.
 * A user reads it once and then stops seeing it, which is the point — it should
 * not compete with the options above it.
 */
export function HintBar({ keys }: Props) {
  return (
    <Text color={UI_COLORS.border} dimColor>
      {keys.map((key) => HINTS[key]).join('  ·  ')}
    </Text>
  );
}

export default HintBar;
