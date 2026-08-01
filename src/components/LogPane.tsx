/**
 * LogPane — bordered, scrollable progress log for the menu screens.
 *
 * Deliberately a dumb renderer: the windowing and scrollbar come pre-resolved
 * from useProgressLog, so nothing here needs a terminal to be correct.
 *
 * It renders nothing until the first line arrives — an idle settings screen
 * should not spend five rows on an empty box — and from then on holds a fixed
 * height so the menu above it never shifts as lines stream in.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { UI_COLORS } from '../theme.js';
import { LOG_PANE_HEIGHT, type LogViewport } from '../utils/logViewport.js';

interface Props {
  view: LogViewport;
  /** Visible rows. Keep in step with the height passed to useProgressLog. */
  height?: number;
  title?: string;
}

export function LogPane({ view, height = LOG_PANE_HEIGHT, title = 'Log' }: Props) {
  if (view.totalLines === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={UI_COLORS.subtitle}>{title}</Text>
      <Box
        borderStyle="round"
        borderColor={UI_COLORS.border}
        paddingX={1}
        height={height + 2}
        overflow="hidden"
      >
        <Box flexDirection="column" flexGrow={1}>
          {view.rows.map((line, row) => (
            <Text key={row} color={UI_COLORS.subtitle} wrap="truncate">
              {line || ' '}
            </Text>
          ))}
        </Box>
        {/* '░' track rather than '│' — a line here reads as a second border. */}
        <Box flexDirection="column" width={1} flexShrink={0} marginLeft={1}>
          {view.scrollbar.map((filled, row) => (
            <Text key={row} color={filled ? UI_COLORS.logo : UI_COLORS.border} dimColor={!filled}>
              {filled ? '█' : '░'}
            </Text>
          ))}
        </Box>
      </Box>
      {/* Always rendered, so scrolling never shifts what sits below the pane. */}
      <Text color={view.hiddenNewer > 0 ? 'yellow' : UI_COLORS.subtitle}>
        {view.hiddenNewer > 0
          ? `↑ ${view.hiddenOlder} older · ↓ ${view.hiddenNewer} newer (PgDn for latest)`
          : view.hiddenOlder > 0
            ? `↑ ${view.hiddenOlder} older (PgUp)`
            : ' '}
      </Text>
    </Box>
  );
}

export default LogPane;
