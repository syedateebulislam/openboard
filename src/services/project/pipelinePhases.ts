/**
 * Pipeline phase model — shared by the TUI progress bar, the agent NDJSON
 * event stream, and run-state persistence.
 *
 * The full create/update pipeline is: parse → analyze → generate → write →
 * build → push → deploy → verify. Weights are rough share-of-wall-clock so a
 * progress bar advances believably; generation dominates.
 */

export type PipelinePhase =
  | 'parse'
  | 'analyze'
  | 'generate'
  | 'write'
  | 'build'
  | 'push'
  | 'deploy'
  | 'verify'
  | 'done';

export const PHASE_ORDER: PipelinePhase[] = [
  'parse',
  'analyze',
  'generate',
  'write',
  'build',
  'push',
  'deploy',
  'verify',
  'done',
];

/** Share of overall progress each phase represents (sums to 100). */
export const PHASE_WEIGHTS: Record<PipelinePhase, number> = {
  parse: 4,
  analyze: 4,
  generate: 40,
  write: 4,
  build: 22,
  push: 8,
  deploy: 14,
  verify: 4,
  done: 0,
};

export const PHASE_LABELS: Record<PipelinePhase, string> = {
  parse: 'Parsing data source',
  analyze: 'Analyzing fields',
  generate: 'Generating dashboard code',
  write: 'Writing generated files',
  build: 'Building project',
  push: 'Pushing to GitHub',
  deploy: 'Deploying to Vercel',
  verify: 'Verifying deployment',
  done: 'Done',
};

/** Overall percent complete at the *start* of the given phase. */
export function phaseStartPct(phase: PipelinePhase): number {
  let pct = 0;
  for (const p of PHASE_ORDER) {
    if (p === phase) return pct;
    pct += PHASE_WEIGHTS[p];
  }
  return 100;
}

export function phaseIndex(phase: PipelinePhase): number {
  return PHASE_ORDER.indexOf(phase);
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface PipelineEvent {
  event: 'phase' | 'log' | 'result';
  phase?: PipelinePhase;
  /** Overall progress 0–100. */
  pct?: number;
  message?: string;
  /** Set on 'result' events. */
  success?: boolean;
}

export type PipelineEventSink = (event: PipelineEvent) => void;

/**
 * PipelineReporter — fans progress out to the legacy line-based callback and
 * the structured event sink, and advances a believable percent within a phase
 * as log lines stream (capped just below the next phase boundary).
 */
export class PipelineReporter {
  private currentPhase: PipelinePhase | undefined;
  private withinPct = 0;
  /** Bound log function — pass this anywhere an onProgress callback is expected. */
  readonly progress: (line: string) => void;

  constructor(
    private onProgress?: (line: string) => void,
    private sink?: PipelineEventSink,
    private onPhaseChange?: (phase: PipelinePhase) => void,
  ) {
    this.progress = (line: string) => this.log(line);
  }

  phase(phase: PipelinePhase, message?: string): void {
    this.currentPhase = phase;
    this.withinPct = 0;
    this.onPhaseChange?.(phase);
    this.sink?.({
      event: 'phase',
      phase,
      pct: phase === 'done' ? 100 : phaseStartPct(phase),
      message: message ?? PHASE_LABELS[phase],
    });
  }

  log(line: string): void {
    this.onProgress?.(line);
    // Each streamed line nudges within-phase progress so long phases
    // (generation, build) visibly move instead of sitting at the boundary.
    let pct: number | undefined;
    if (this.currentPhase && this.currentPhase !== 'done') {
      const weight = PHASE_WEIGHTS[this.currentPhase];
      this.withinPct = Math.min(this.withinPct + Math.max(1, weight / 20), weight * 0.95);
      pct = Math.round(phaseStartPct(this.currentPhase) + this.withinPct);
    }
    this.sink?.({ event: 'log', message: line, phase: this.currentPhase, pct });
  }

  result(success: boolean, message?: string): void {
    this.sink?.({ event: 'result', success, message, pct: success ? 100 : undefined });
  }

  get phaseNow(): PipelinePhase | undefined {
    return this.currentPhase;
  }
}
