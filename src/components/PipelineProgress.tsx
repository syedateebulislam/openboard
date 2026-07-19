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
  /**
   * Phases of the CURRENT operation. A plain /build must read "[1/1] Building
   * project", not "[5/8]" against the full create pipeline. Defaults to the
   * full pipeline for operations that really run every phase.
   */
  phases?: PipelinePhase[];
}

export function PipelineProgress({ phase, pct, phaseStartedAt, typicalMs, phases }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((now - phaseStartedAt) / 1000));
  const order = phases && phases.includes(phase) ? phases : PHASE_ORDER;
  const working = order.filter((p) => p !== 'done');
  const phaseNumber = Math.min(order.indexOf(phase) + 1, working.length);
  const phaseTotal = working.length;
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
