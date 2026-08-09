/**
 * IntegrationsScreen — where OpenBoardCLI's data comes from.
 *
 * Gmail is the only source today, so this is a one-row list. It exists as a
 * level anyway: invoice fetching was buried under Settings, which framed a
 * primary way of getting data into OpenBoardCLI as a preference. With the parent
 * here, the next source is a new row rather than a reorganisation.
 */
import React, { useState } from 'react';
import { Box, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { Screen } from '../App.js';
import { ScreenFrame } from '../components/ScreenFrame.js';
import { parentOf } from '../config/navigation.js';
import { TypedConfigRepository } from '../services/config/TypedConfigRepository.js';
import { discoverBillers } from '../services/billers/BillerDiscoveryService.js';

interface Props {
  onNavigate: (s: Screen) => void;
}

/** One line per source, shown for the highlighted row. */
const DETAIL: Record<string, string> = {
  gmail: 'Read invoices from Gmail over IMAP and turn each biller into a dashboard.',
  back: 'Return to the main menu.',
};

export function IntegrationsScreen({ onNavigate }: Props) {
  const [highlighted, setHighlighted] = useState('gmail');

  useInput((_input, key) => {
    if (key.escape) onNavigate(parentOf('integrations'));
  });

  const settings = new TypedConfigRepository().getBillerSettings();
  const connected = Boolean(settings.email && settings.appPassword && settings.scriptsDir);
  const billerCount = settings.scriptsDir ? discoverBillers(settings.scriptsDir).length : 0;

  // The row carries its own state, so the screen needs no status line above it.
  const gmailLabel = connected
    ? `Gmail — ${settings.email}`
    : 'Gmail — not connected';

  const items = [
    { label: gmailLabel, value: 'gmail' },
    { label: '← Back', value: 'back' },
  ];

  return (
    <ScreenFrame
      title="Integrations"
      meta={[
        connected ? 'gmail connected' : 'nothing connected yet',
        connected && billerCount > 0 && `${settings.enabledKeys.length} of ${billerCount} billers on`,
      ]}
      detail={DETAIL[highlighted]}
      hints={['move', 'select', 'back']}
    >
      <Box>
        <SelectInput
          items={items}
          onHighlight={(item) => setHighlighted(item.value)}
          onSelect={(item) => onNavigate(item.value === 'gmail' ? 'integrations-gmail' : parentOf('integrations'))}
        />
      </Box>
    </ScreenFrame>
  );
}

export default IntegrationsScreen;
