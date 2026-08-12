import React, { useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';
import { HintBar } from '../components/HintBar.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { bannerVersionLine } from '../version.js';
import { describeAppMode, getAppMode, isValidAppMode } from '../config/appModes.js';
import { ConfigService } from '../services/config/ConfigService.js';

interface Props {
  onNavigate: (s: Screen) => void;
}

type MenuValue = Screen | 'exit';

/** One line per destination, shown for the highlighted row only. */
const DETAIL: Record<string, string> = {
  setup: 'Connect an LLM and choose what leaves your machine.',
  integrations: 'Where your data comes from — Gmail invoices, and more later.',
  'manage-boards': 'Create, modify and regenerate your dashboards.',
  settings: 'Mode, provider and credentials.',
  exit: 'Close OpenBoardCLI.',
};

/** Columns the boxed banner needs: 41 for the box, plus padding={2} each side. */
const BANNER_MIN_COLUMNS = 45;

export function WelcomeScreen({ onNavigate }: Props) {
  const [highlighted, setHighlighted] = useState('setup');
  const { columns } = useTerminalSize();

  // Until setup runs, don't advertise the default mode as if it were chosen.
  let configured = false;
  let mode: string | undefined;
  let provider: string | undefined;
  let configError: string | undefined;
  try {
    const config = new ConfigService();
    configured = Boolean(config.get('llm.provider'));
    provider = config.get('llm.provider') as string | undefined;
    mode = isValidAppMode(config.get('app.mode'))
      ? describeAppMode(getAppMode(config))
      : undefined;
  } catch (error) {
    // A config that cannot be read is not the same as a config that is not
    // there, but both rendered as "not configured yet" — so a corrupted or
    // unreadable ~/.openboard/config.json looked exactly like a fresh install,
    // and the advice ("start here") was wrong in a way the user could not see.
    mode = undefined;
    configError = error instanceof Error ? error.message : String(error);
  }

  const menuItems = [
    { label: configured ? 'Onboarding' : 'Onboarding — start here', value: 'setup' as MenuValue },
    { label: 'Integrations', value: 'integrations' as MenuValue },
    { label: 'Dashboards', value: 'manage-boards' as MenuValue },
    { label: 'Settings', value: 'settings' as MenuValue },
    { label: 'Exit', value: 'exit' as MenuValue },
  ];

  const handleSelect = (item: typeof menuItems[0]) => {
    if (item.value === 'exit') {
      process.exit(0);
    }
    onNavigate(item.value);
  };

  // The box is 41 columns plus the container's padding on both sides. Below
  // that it does not degrade gracefully — every row wraps and the frame comes
  // apart into a staircase — so a narrow terminal gets a plain title instead.
  // At normal widths this renders exactly as before, which the TUI frame
  // snapshots depend on.
  const compact = columns < BANNER_MIN_COLUMNS;

  return (
    <Box flexDirection="column" padding={2}>
      <Box flexDirection="column">
        {compact ? (
          <>
            <Text bold color={UI_COLORS.logo}>[&gt;_] OpenBoardCLI</Text>
            <Text color={UI_COLORS.subtitle}>Analytics Dashboard Generator</Text>
            <Text color={UI_COLORS.subtitle}>{bannerVersionLine().trim()}</Text>
          </>
        ) : (
          <>
        <Text bold color={UI_COLORS.border}>╔═══════════════════════════════════════╗</Text>
        <Text>
          <Text bold color={UI_COLORS.border}>║</Text>
          {/* String literal, not JSX text: a bare `>` is not valid JSX, and it
              keeps the 39-char padding explicit rather than significant whitespace. */}
          <Text bold color={UI_COLORS.logo}>{'           [>_] OpenBoardCLI           '}</Text>
          <Text bold color={UI_COLORS.border}>║</Text>
        </Text>
        <Text>
          <Text bold color={UI_COLORS.border}>║</Text>
          <Text color={UI_COLORS.subtitle}>     Analytics Dashboard Generator     </Text>
          <Text bold color={UI_COLORS.border}>║</Text>
        </Text>
        <Text>
          <Text bold color={UI_COLORS.border}>║</Text>
          <Text color={UI_COLORS.subtitle}>{bannerVersionLine()}</Text>
          <Text bold color={UI_COLORS.border}>║</Text>
        </Text>
        <Text bold color={UI_COLORS.border}>╚═══════════════════════════════════════╝</Text>
          </>
        )}
      </Box>
      
      {/* Facts, not a sentence: the mode and provider read at a glance.
          Only replaced when the config could not be read at all — which is a
          different thing from an empty config, and says so. Costs no extra
          line in the normal case, so the screen's line budget is unchanged. */}
      <Box marginTop={1}>
        {configError ? (
          <Text color="red">
            Could not read your configuration: {configError}
          </Text>
        ) : (
          <Text color={UI_COLORS.border} dimColor>
            {[mode?.toLowerCase(), provider].filter(Boolean).join('  ·  ') || 'not configured yet'}
          </Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <SelectInput
          items={menuItems}
          onHighlight={(item) => setHighlighted(item.value)}
          onSelect={handleSelect}
        />
      </Box>

      {/* Reserved, so moving the cursor never shifts the hints below it. */}
      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>{DETAIL[highlighted] || ' '}</Text>
      </Box>

      <Box marginTop={1}>
        <HintBar keys={['move', 'select']} />
      </Box>
    </Box>
  );
}
