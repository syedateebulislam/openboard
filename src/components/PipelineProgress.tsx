/**
 * PipelineProgress — composite progress line for long pipeline operations.
 *
 * Renders: spinner + phase label + weighted progress bar + elapsed time
 * (+ "usually ~Ns" when a typical duration is known from run history).
 * One shared component so ChatScreen, BoardCreationScreen, and
 * ManageBoardsScreen show identical progress UX.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { ProgressBar } from './ProgressBar.js';
import { PHASE_LABELS, PHASE_ORDER } from '../services/project/pipelinePhases.js';
import type { PipelinePhase } from '../services/project/pipelinePhases.js';
import { UI_COLORS } from '../theme.js';

export interface PipelineProgressState {
  phase: PipelinePhase;
  pct: number;
  /** Epoch ms when the current phase started. */
  phaseStartedAt: number;
}

interface Props {
  phase: PipelinePhase;
  pct: number;
  phaseStartedAt: number;
  /** Typical duration of this phase from run history (ms). */
  typicalMs?: number;
}

export function PipelineProgress({ phase, pct, phaseStartedAt, typicalMs }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((now - phaseStartedAt) / 1000));
  const phaseNumber = Math.min(PHASE_ORDER.indexOf(phase) + 1, PHASE_ORDER.length - 1);
  const phaseTotal = PHASE_ORDER.length - 1; // 'done' is not a working phase
  const typicalText = typicalMs ? ` (usually ~${Math.round(typicalMs / 1000)}s)` : '';

  return (
    <Box>
      <Text color={UI_COLORS.logo}>
        <Spinner type="dots" />
      </Text>
      <Text> [{phaseNumber}/{phaseTotal}] {PHASE_LABELS[phase]} </Text>
      <ProgressBar value={pct} width={16} />
      <Text color={UI_COLORS.subtitle}> {elapsedSec}s{typicalText}</Text>
    </Box>
  );
}

export default PipelineProgress;
