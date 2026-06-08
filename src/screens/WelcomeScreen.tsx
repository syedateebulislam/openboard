import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';

interface Props {
  onNavigate: (s: Screen) => void;
}

type MenuValue = Screen | 'exit';

const menuItems = [
  { label: 'LLM Setup', value: 'setup' as MenuValue },
  { label: 'Dashboards', value: 'manage-boards' as MenuValue },
  { label: 'Settings', value: 'settings' as MenuValue },
  { label: 'Exit', value: 'exit' as MenuValue },
];

export function WelcomeScreen({ onNavigate }: Props) {
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
          <Text bold color={UI_COLORS.logo}>        [_-_] O p e n B o a r d        </Text>
          <Text bold color={UI_COLORS.border}>║</Text>
        </Text>
        <Text>
          <Text bold color={UI_COLORS.border}>║</Text>
          <Text color={UI_COLORS.subtitle}>     Analytics Dashboard Generator     </Text>
          <Text bold color={UI_COLORS.border}>║</Text>
        </Text>
        <Text>
          <Text bold color={UI_COLORS.border}>║</Text>
          <Text color={UI_COLORS.subtitle}>                v1.0.0                 </Text>
          <Text bold color={UI_COLORS.border}>║</Text>
        </Text>
        <Text bold color={UI_COLORS.border}>╚═══════════════════════════════════════╝</Text>
      </Box>
      
      <Box marginTop={1} flexDirection="column">
        <SelectInput items={menuItems} onSelect={handleSelect} />
      </Box>
      
      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>Use ↑↓ arrows to navigate, Enter to select</Text>
      </Box>
    </Box>
  );
}
