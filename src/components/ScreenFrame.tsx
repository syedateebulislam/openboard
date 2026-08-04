/**
 * ScreenFrame — the shell every menu screen renders through.
 *
 * The screens had drifted into rendering their own headers: a title, a two-line
 * subtitle, a stack of status lines, then a paragraph of guidance, and only
 * then the first option. On the invoice-fetcher screen that was twelve lines of
 * chrome above anything selectable, on a pane that also has to fit a log.
 *
 * The frame fixes what a screen may spend before its options:
 *
 *   Integrations › Gmail          ← breadcrumb, one line
 *   ready · 8 billers · 3 on      ← meta: facts, joined, one line
 *   <the screen's own body>
 *   App Passwords are encrypted…  ← detail: describes the highlighted row only
 *   ↑↓ move · ⏎ select · esc back ← hints, worded once in HintBar
 *
 * `meta` and `detail` are single lines by contract. Facts arrive as an array so
 * a screen states them and the frame decides how they read; the alternative —
 * each screen joining its own — is how five stacked status lines happened.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { UI_COLORS } from '../theme.js';
import { HintBar, type HintKey } from './HintBar.js';

interface Props {
  /** Breadcrumb segments, outermost first: `['Integrations', 'Gmail']`. */
  title: string | string[];
  /** Short facts. Empty entries are dropped so callers can inline conditions. */
  meta?: (string | false | undefined)[];
  /** One line describing the highlighted option. */
  detail?: string;
  hints: HintKey[];
  /** Transient outcome of the last action. */
  status?: string;
  statusTone?: 'ok' | 'busy' | 'error';
  children: React.ReactNode;
}

const TONE_COLOR = { ok: 'green', busy: 'yellow', error: 'red' } as const;

/**
 * Classify a status line when the caller has not.
 *
 * Screens were each running their own regex over the message to pick a colour,
 * and they disagreed — one treated "not configured" as success because it only
 * looked for the word "saved".
 */
export function statusTone(message: string, busy = false): 'ok' | 'busy' | 'error' {
  if (busy) return 'busy';
  return /\b(fail|failed|error|invalid|cannot|could not|must be|required|missing|no )\b/i.test(message)
    ? 'error'
    : 'ok';
}

export function ScreenFrame({ title, meta, detail, hints, status, statusTone: tone, children }: Props) {
  const crumbs = Array.isArray(title) ? title : [title];
  const facts = (meta ?? []).filter((fact): fact is string => Boolean(fact));

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text>
        {crumbs.map((crumb, index) => (
          <React.Fragment key={crumb}>
            {index > 0 && <Text color={UI_COLORS.border}> › </Text>}
            <Text bold={index === crumbs.length - 1} color={UI_COLORS.logo}>{crumb}</Text>
          </React.Fragment>
        ))}
      </Text>

      {facts.length > 0 && (
        <Text color={UI_COLORS.border} dimColor>{facts.join('  ·  ')}</Text>
      )}

      <Box marginTop={1} flexDirection="column">{children}</Box>

      {/*
        Reserved whether or not there is a detail to show. Letting the line
        appear and vanish as the cursor moves shifts everything below it, which
        on a menu with a log pane beneath is worse than an empty row.
      */}
      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>{detail || ' '}</Text>
      </Box>

      {status && <Text color={TONE_COLOR[tone ?? statusTone(status)]}>{status}</Text>}

      <Box marginTop={1}>
        <HintBar keys={hints} />
      </Box>
    </Box>
  );
}

export default ScreenFrame;
