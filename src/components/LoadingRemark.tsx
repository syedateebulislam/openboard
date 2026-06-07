import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import InkSpinner from 'ink-spinner';
import { DASHBOARD_LOADING_REMARKS } from '../constants/loadingRemarks.js';
import { UI_COLORS } from '../theme.js';

const SHIMMER_WIDTH = 8;
const FRAME_MS = 15;
const REMARK_MS = 10_000;
const SOFT_HIGHLIGHT = '#E4C5AB';
const MID_HIGHLIGHT = '#D4A17D';

export function shouldReduceLoadingMotion(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.OPENBOARD_REDUCE_MOTION?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || Boolean(env.NO_COLOR) || Boolean(env.CI);
}

function randomRemarkIndex(except?: number): number {
  if (DASHBOARD_LOADING_REMARKS.length <= 1) return 0;

  let next = Math.floor(Math.random() * DASHBOARD_LOADING_REMARKS.length);
  while (next === except) {
    next = Math.floor(Math.random() * DASHBOARD_LOADING_REMARKS.length);
  }
  return next;
}

function waveColor(index: number, phase: number): string {
  const distance = Math.abs(index - phase);
  if (distance <= 1) return UI_COLORS.logo;
  if (distance <= 3) return MID_HIGHLIGHT;
  if (distance <= SHIMMER_WIDTH) return SOFT_HIGHLIGHT;
  return UI_COLORS.subtitle;
}

export function LoadingRemark() {
  const [remarkIndex, setRemarkIndex] = useState(() => randomRemarkIndex());
  const [phase, setPhase] = useState(-SHIMMER_WIDTH);
  const remark = DASHBOARD_LOADING_REMARKS[remarkIndex];
  const reduceMotion = shouldReduceLoadingMotion();

  useEffect(() => {
    if (reduceMotion) return;
    const timer = setInterval(() => {
      setPhase((current) => {
        const next = current + 1;
        return next > remark.length + SHIMMER_WIDTH ? -SHIMMER_WIDTH : next;
      });
    }, FRAME_MS);

    return () => clearInterval(timer);
  }, [remark.length, reduceMotion]);

  useEffect(() => {
    if (reduceMotion) return;
    const timer = setInterval(() => {
      setRemarkIndex((current) => randomRemarkIndex(current));
      setPhase(-SHIMMER_WIDTH);
    }, REMARK_MS);

    return () => clearInterval(timer);
  }, [reduceMotion]);

  if (reduceMotion) {
    return (
      <Box>
        <Text color={UI_COLORS.logo}>...</Text>
        <Text> </Text>
        <Text color={UI_COLORS.subtitle}>{remark}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color={UI_COLORS.logo}>
        <InkSpinner type="dots" />
      </Text>
      <Text> </Text>
      {[...remark].map((char, index) => (
        <Text key={`${remarkIndex}-${index}`} color={waveColor(index, phase)}>
          {char}
        </Text>
      ))}
    </Box>
  );
}

export default LoadingRemark;
