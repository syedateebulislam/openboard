import React, { useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';
import { HintBar } from '../components/HintBar.js';
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

export function WelcomeScreen({ onNavigate }: Props) {
  const [highlighted, setHighlighted] = useState('setup');

  // Until setup runs, don't advertise the default mode as if it were chosen.
  let configured = false;
  let mode: string | undefined;
  let provider: string | undefined;
  try {
    const config = new ConfigService();
    configured = Boolean(config.get('llm.provider'));
    provider = config.get('llm.provider') as string | undefined;
    mode = isValidAppMode(config.get('app.mode'))
      ? describeAppMode(getAppMode(config))
      : undefined;
  } catch {
    mode = undefined;
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

  return (
    <Box flexDirection="column" padding={2}>
      <Box flexDirection="column">
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
      </Box>
      
      {/* Facts, not a sentence: the mode and provider read at a glance. */}
      <Box marginTop={1}>
        <Text color={UI_COLORS.border} dimColor>
          {[mode?.toLowerCase(), provider].filter(Boolean).join('  ·  ') || 'not configured yet'}
        </Text>
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
