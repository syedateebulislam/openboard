import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';
import { bannerVersionLine } from '../version.js';
import { describeAppMode, getAppMode, isValidAppMode } from '../config/appModes.js';
import { ConfigService } from '../services/config/ConfigService.js';
import type { MailSchedulerStatus } from '../types/mail.js';

interface Props {
  onNavigate: (s: Screen) => void;
  mailStatus?: MailSchedulerStatus | null;
}

type MenuValue = Screen | 'exit';

const clockTime = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined;

/** One-line Gmail sync summary; null when Gmail is not connected. */
export function mailStatusLine(status: MailSchedulerStatus | null | undefined): string | null {
  if (!status || status.state === 'not-configured') return null;
  if (status.state === 'needs-reauth') return '✉ Gmail: re-auth needed — Settings › Gmail integration';
  const parts = [`${status.totalCached ?? 0} cached`];
  const last = clockTime(status.lastSyncAt);
  if (status.state === 'syncing') parts.push('syncing…');
  else if (last) parts.push(`last sync ${last}`);
  const next = clockTime(status.nextSyncAt);
  if (status.state !== 'syncing' && next) parts.push(`next ${next}`);
  if (status.state === 'error' && status.error) parts.push('last sync failed');
  return `✉ Gmail: ${parts.join(' · ')}`;
}

export function WelcomeScreen({ onNavigate, mailStatus }: Props) {
  // Until setup runs, don't advertise the default mode as if it were chosen.
  let configured = false;
  let modeLine: string | undefined;
  try {
    const config = new ConfigService();
    configured = Boolean(config.get('llm.provider'));
    modeLine = isValidAppMode(config.get('app.mode'))
      ? describeAppMode(getAppMode(config))
      : 'not configured yet — run Setup to choose one';
  } catch {
    modeLine = undefined;
  }

  const menuItems = [
    { label: configured ? 'Setup' : 'Get started — set up OpenBoard', value: 'setup' as MenuValue },
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
          <Text color={UI_COLORS.subtitle}>{bannerVersionLine()}</Text>
          <Text bold color={UI_COLORS.border}>║</Text>
        </Text>
        <Text bold color={UI_COLORS.border}>╚═══════════════════════════════════════╝</Text>
      </Box>
      
      {modeLine && (
        <Box marginTop={1}>
          <Text color={UI_COLORS.subtitle}>Mode: {modeLine}</Text>
        </Box>
      )}

      {mailStatusLine(mailStatus) && (
        <Box>
          <Text color={UI_COLORS.subtitle}>{mailStatusLine(mailStatus)}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <SelectInput items={menuItems} onSelect={handleSelect} />
      </Box>
      
      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>Use ↑↓ arrows to navigate, Enter to select</Text>
      </Box>
    </Box>
  );
}
