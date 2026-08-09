/**
 * ChatScreen — Primary LLM interaction interface for OpenBoardCLI.
 *
 * Users type natural language messages to generate or modify dashboard
 * components. Special commands (/deploy, /push, /build, /help, etc.) are
 * intercepted before reaching the LLM and routed to the appropriate service.
 *
 * Phase 4: Chat Interface + Iteration
 */
import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { existsSync, statSync } from 'node:fs';
import { ChatLineRow } from '../components/ChatMessage.js';
import {
  clampOffset,
  flattenMessages,
  maxScrollOffset,
  pageStep,
  scrollbarColumn,
  visibleLines,
} from '../utils/chatViewport.js';
import type { WrapCache } from '../utils/chatViewport.js';
import { LoadingRemark } from '../components/LoadingRemark.js';
import { PipelineProgress } from '../components/PipelineProgress.js';
import { PipelineReporter, PHASE_ORDER } from '../services/project/pipelinePhases.js';
import type { PipelinePhase, PipelineEventSink } from '../services/project/pipelinePhases.js';
import { DashboardUpdateService } from '../services/project/DashboardUpdateService.js';
import { DashboardManifestService } from '../services/project/DashboardManifestService.js';
import { RunStateService } from '../services/project/RunStateService.js';
import type { RunRecord } from '../services/project/RunStateService.js';
import { parseCommand, chatCommandsForMode, commandsTextForMode, helpTextForMode, formatUnknownCommandMessage } from '../utils/commandParser.js';
import { appModeInfo, blockedDeployMessage, describeAppMode, getAppMode, modeAllowsDeploy } from '../config/appModes.js';
import type { ChatMessage, BoardConfig } from '../types/board.js';
import type { LLMProvider, LLMMessage } from '../types/llm.js';
import { LLMService } from '../services/llm/LLMService.js';
import { fetchInstalledModels } from '../services/llm/localModelDiscovery.js';
import { ConfigService } from '../services/config/ConfigService.js';
import { ProjectManager } from '../services/project/ProjectManager.js';
import { TemplateService } from '../services/template/TemplateService.js';
import { DataParserService } from '../services/data/DataParserService.js';
import { DataAnalyzer } from '../services/data/DataAnalyzer.js';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_LOW } from '../services/llm/prompts/systemPrompt.js';
import { extractFiles } from '../utils/codeExtractor.js';
import { describeLLMError, isErrorShapedContent } from '../utils/errorCodes.js';
import type { Screen } from '../App.js';
import { BoardRegistryService } from '../services/project/BoardRegistryService.js';
import { PromptHistoryService } from '../services/project/PromptHistoryService.js';
import { UI_COLORS } from '../theme.js';
import { HintBar } from '../components/HintBar.js';
import { DEFAULT_EFFORT, LLM_EFFORTS, MODEL_CHOICES, defaultModelFor as getDefaultModel, isValidEffort, normalizeEffort } from '../config/llmCatalog.js';
import type { LLMEffort, LLMProviderName } from '../types/llm.js';
import { ProjectCommandHandlers } from '../services/commands/ProjectCommandHandlers.js';
import { TypedConfigRepository } from '../services/config/TypedConfigRepository.js';
import { BillerFetcherService } from '../services/billers/BillerFetcherService.js';
import { recordBillerRun, shouldAnchorRun } from '../services/billers/billerScheduler.js';
import type { BillerSchedulerStatus } from '../types/billers.js';

const projectManager = new ProjectManager();
const projectCommands = new ProjectCommandHandlers(projectManager);

// ─── Message ID generator using crypto for uniqueness ───────────────────────
function generateMsgId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function newMsg(
  role: ChatMessage['role'],
  content: string,
  isStreaming = false,
): ChatMessage {
  return {
    id: generateMsgId(),
    role,
    content,
    timestamp: Date.now(),
    isStreaming,
  };
}

/**
 * Regenerate the product-owned dashboard manifest (tabs + routing) from the
 * board registry. App.tsx renders tabs exclusively from
 * generated/dashboardManifest.tsx, so the TUI must sync it before building —
 * otherwise dashboards generated in chat never receive a tab. Must run after
 * syncMasterTab so a fresh MasterDashboard.tsx is picked up as the Overview tab.
 */
async function syncDashboardManifest(
  projectDir: string,
  onProgress: (line: string) => void,
): Promise<void> {
  try {
    const boards = new BoardRegistryService().listBoards();
    const result = await new DashboardManifestService().sync(projectDir, boards);
    onProgress(`Updated dashboard tabs (${boards.length} dashboard(s)).`);
    if (result.missingBoards.length > 0) {
      onProgress(`Warning: ${result.missingBoards.join(', ')} has no generated dashboard yet — open its chat and ask for one.`);
    }
  } catch (error: any) {
    onProgress(`Warning: dashboard tab update skipped: ${error.message}`);
  }
}

// Default models come from the shared catalog (src/config/llmCatalog.ts).

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  board: BoardConfig;
  onNavigate?: (screen: Screen) => void;
  messages?: ChatMessage[];
  autoGenerateInitial?: boolean;
  /** All-boards mode: each prompt is applied to every dashboard, deployed once. */
  allBoards?: boolean;
  /** Live invoice-fetch scheduler state, owned by App. Null until it reports. */
  billerStatus?: BillerSchedulerStatus | null;
}

interface SendToLLMOptions {
  recordPrompt?: boolean;
  promptSource?: 'initial' | 'manual' | 'update';
  signal?: AbortSignal;
  dataSummary?: string;
}

// ─── ChatScreen ───────────────────────────────────────────────────────────────

// Maximum messages to keep in history to prevent memory issues
const MAX_MESSAGES = 100;
// Maximum chat history messages to include in LLM context
const MAX_CONTEXT_MESSAGES = 20;

// Chrome around the chat log, in terminal rows: outer frame border (2), header
// box (3 lines + border + padding + margin = 8), input box (3), footer hint
// (1), loader slot (1), scroll status (1). Overshooting here makes the log
// taller than the terminal, which breaks the fixed layout entirely — so the log
// takes what is left, never a fixed fraction of the screen.
const CHROME_ROWS = 16;
const MIN_LOG_HEIGHT = 5;

/**
 * The invoice scheduler's one-line header readout.
 *
 * Returns null when there is nothing worth a row, because the line is counted
 * against the chat log's height — an unconfigured loop must not cost the user a
 * line of history. The loop is otherwise entirely silent, which is why a
 * correctly-spaced interval was indistinguishable from a dead one.
 */
function describeBillerStatus(status: BillerSchedulerStatus | null | undefined): string | null {
  if (!status || status.state === 'not-configured') return null;
  if (status.state === 'running') return '🧾 Invoices: fetching…';
  if (status.state === 'error') {
    return `🧾 Invoices: ${(status.error ?? 'last fetch failed').slice(0, 60)}`;
  }
  if (!status.nextRunAt) return null;
  const at = new Date(status.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `🧾 Invoices: next fetch ${at}`;
}

function isVercelAuthError(error: string | undefined): boolean {
  if (!error) return false;
  return /Vercel is not authenticated|No existing credentials|specified token is not valid|vercel login/i.test(error);
}

function reportDeployResult(
  deployResult: { success: boolean; error?: string; url?: string },
  pushedToGitHub: boolean,
  onProgress: (line: string) => void,
): void {
  if (deployResult.success) {
    onProgress(`Deployed to Vercel: ${deployResult.url || 'Success'}`);
    return;
  }

  if (pushedToGitHub && isVercelAuthError(deployResult.error)) {
    onProgress('Pushed to GitHub. Vercel Git integration should deploy this commit automatically.');
    onProgress('Direct Vercel CLI deploy was skipped because local Vercel auth is not available.');
    onProgress('   Re-enter the Vercel token in Settings only if you want OpenBoardCLI to run direct CLI deploys and set Vercel env vars.');
    return;
  }

  onProgress(`Vercel deployment failed: ${deployResult.error}`);
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function fileModifiedAt(path: string): string {
  try {
    return statSync(path).mtime.toLocaleString();
  } catch {
    return 'unknown';
  }
}

export function ChatScreen({
  board,
  onNavigate,
  messages: initialMessages = [],
  autoGenerateInitial = false,
  allBoards = false,
  billerStatus = null,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    newMsg(
      'system',
      allBoards
        ? 'Modify-all mode: each message you send is applied to EVERY dashboard, then the app is deployed once. Slash commands (/deploy, /preview, /status) act on the shared app.'
        : 'Type a message to generate components or use slash commands (/help for list)',
    ),
    ...initialMessages,
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pipeline, setPipeline] = useState<{ phase: PipelinePhase; pct: number; phaseStartedAt: number } | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<'deploy' | 'push' | null>(null);
  // Chat history scrolling: scrollOffset = how many rendered LINES are hidden
  // BELOW the visible window (0 = pinned to the newest). Bottom-anchored, so
  // new log lines never yank the reader back down mid-read; line-addressed, so
  // a page of PgUp always moves exactly one screenful.
  const [scrollOffset, setScrollOffset] = useState(0);
  const [llmProvider, setLlmProvider] = useState<LLMProvider | null>(null);
  const [llmMeta, setLlmMeta] = useState<{ model: string; effort: LLMEffort } | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const streamingMsgRef = useRef<string | null>(null);
  const logMsgRef = useRef<string | null>(null);
  const lastOperationLogRef = useRef<string>('');
  // What /stop can cancel right now, and which persisted run (if any) it should
  // mark 'cancelled' so /resume has a "leftover task" to pick back up.
  const activeAbortRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<RunRecord | null>(null);
  const autoGenTriggered = useRef(false);
  const headerTitle = allBoards ? 'All Dashboards' : autoGenerateInitial ? 'New Dashboard' : board.title;
  const headerLLMInfo = llmProvider && llmMeta
    ? `LLM - ${llmProvider.name} · ${llmMeta.model} · effort: ${llmMeta.effort}`
    : 'LLM - not configured';

  // ── Initialize LLM provider from config (re-run by /model) ───────────────
  const initLLMFromConfig = useCallback(() => {
    try {
      const config = new ConfigService();
      const provider = config.get('llm.provider') as string | undefined;
      const model = config.get('llm.model') as string | undefined;

      if (!provider) {
        setLlmError('No LLM provider configured. Run setup first (/config).');
        return;
      }

      // Retrieve API key — try encrypted first, then plaintext
      let apiKey: string | undefined;
      try {
        apiKey = config.getDecrypted('llm.apiKey');
      } catch {
        apiKey = config.get('llm.apiKey') as string | undefined;
      }

      const ollamaHost = config.get('llm.ollamaHost') as string | undefined;
      const baseUrl = config.get('llm.baseUrl') as string | undefined;

      const llmConfig = {
        provider: provider as LLMProviderName,
        model: model || getDefaultModel(provider),
        apiKey,
        baseUrl,
        ollamaHost,
        effort: normalizeEffort(config.get('llm.effort')),
      };

      const createdProvider = LLMService.createProvider(llmConfig);
      setLlmProvider(createdProvider);
      setLlmMeta({ model: llmConfig.model, effort: llmConfig.effort });
      setLlmError(null);
    } catch (err: any) {
      setLlmError(`Failed to initialize LLM: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    initLLMFromConfig();
  }, [initLLMFromConfig]);

  const addMsg = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      const updated = [...prev, msg];
      if (updated.length > MAX_MESSAGES) {
        return updated.slice(-MAX_MESSAGES);
      }
      return updated;
    });
  }, []);

  // Throttle streaming updates to ~60ms intervals to reduce re-renders
  const streamThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStreamRef = useRef<{ id: string; content: string } | null>(null);

  const flushStreamUpdate = useCallback(() => {
    const pending = pendingStreamRef.current;
    if (pending) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === pending.id ? { ...msg, content: pending.content } : msg,
        ),
      );
      pendingStreamRef.current = null;
    }
  }, []);

  const updateStreamingMsg = useCallback((id: string, content: string, done: boolean) => {
    if (done) {
      // Final update — flush immediately
      if (streamThrottleRef.current) {
        clearTimeout(streamThrottleRef.current);
        streamThrottleRef.current = null;
      }
      pendingStreamRef.current = null;
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === id ? { ...msg, content, isStreaming: false } : msg,
        ),
      );
      return;
    }

    // Buffer the update
    pendingStreamRef.current = { id, content };
    if (!streamThrottleRef.current) {
      streamThrottleRef.current = setTimeout(() => {
        streamThrottleRef.current = null;
        flushStreamUpdate();
      }, 60);
    }
  }, [flushStreamUpdate]);

  const startLogMsg = useCallback((label: string): string => {
    const msg = newMsg('system', `${label}\n`, true);
    logMsgRef.current = msg.id;
    lastOperationLogRef.current = `${label}\n`;
    setMessages((prev) => {
      const updated = [...prev, msg];
      return updated.length > MAX_MESSAGES ? updated.slice(-MAX_MESSAGES) : updated;
    });
    return msg.id;
  }, []);

  const appendLog = useCallback((id: string, line: string) => {
    lastOperationLogRef.current += `${line}\n`;
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === id ? { ...msg, content: msg.content + line + '\n' } : msg,
      ),
    );
  }, []);

  const finishLog = useCallback((id: string) => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === id ? { ...msg, isStreaming: false } : msg,
      ),
    );
    logMsgRef.current = null;
  }, []);

  const createProgressCallback = useCallback((logId: string) => {
    return (line: string) => {
      appendLog(logId, line);
    };
  }, [appendLog]);

  // Typical per-phase durations from run history, for "usually ~Ns" hints.
  const typicalDurations = useMemo(() => {
    const map: Partial<Record<PipelinePhase, number>> = {};
    try {
      const runs = new RunStateService();
      for (const phase of PHASE_ORDER) {
        if (phase === 'done') continue;
        map[phase] = runs.typicalPhaseDuration(phase);
      }
    } catch {
      // history unavailable — hints are optional
    }
    return map;
  }, []);

  /**
   * Pipeline reporter whose event sink drives the on-screen progress bar.
   * Pass `reporter.progress` wherever an onProgress callback is expected and
   * call `reporter.phase(...)` at stage boundaries.
   */
  const pipelineEventSink = useCallback<PipelineEventSink>((event) => {
    if (event.event === 'result' || event.phase === 'done') {
      setPipeline(null);
      return;
    }
    if (event.event === 'phase' && event.phase) {
      setPipeline({ phase: event.phase, pct: event.pct ?? 0, phaseStartedAt: Date.now() });
    } else if (event.event === 'log' && event.phase && event.pct !== undefined) {
      setPipeline((prev) => (prev && prev.phase === event.phase ? { ...prev, pct: event.pct! } : prev));
    }
  }, []);

  const makePipelineReporter = useCallback((onProgress: (line: string) => void): PipelineReporter => {
    return new PipelineReporter(onProgress, pipelineEventSink);
  }, [pipelineEventSink]);

  // Phases of the operation currently driving the progress bar, so a plain
  // /build shows "[1/1]" instead of "[5/8]" against the full create pipeline.
  const opPhasesRef = useRef<PipelinePhase[] | null>(null);

  const getActiveProjectDir = useCallback((): string => {
    if (board.outputDir) return board.outputDir;
    const sharedDir = new BoardRegistryService().getSharedProjectDir();
    return sharedDir ?? '';
  }, [board.outputDir]);

  // All-boards mode: apply one prompt to every dashboard and deploy once.
  const runModifyAll = useCallback(async (text: string, signal?: AbortSignal): Promise<void> => {
    const projectDir = getActiveProjectDir();
    if (!projectDir) {
      addMsg(newMsg('error', 'No generated app workspace found. Create a dashboard first.'));
      setIsLoading(false);
      return;
    }
    const logId = startLogMsg(`Applying to all dashboards: "${text}"`);
    const onProgress = createProgressCallback(logId);
    try {
      const service = new DashboardUpdateService(undefined, undefined, undefined, undefined, pipelineEventSink);
      const result = await service.updateAllWithPrompt(text, onProgress, undefined, signal);
      if (result.success) {
        onProgress(result.deployUrl ? `Modified all dashboards. Deployed: ${result.deployUrl}` : 'Modified all dashboards.');
      } else {
        onProgress(`Modify-all failed: ${describeLLMError(result.error, llmProvider?.name)}`);
      }
    } catch (error: any) {
      onProgress(error?.name === 'AbortError' ? '⏹ Stopped by user.' : `Modify-all error: ${error.message}`);
    } finally {
      setPipeline(null);
      finishLog(logId);
      setIsLoading(false);
    }
  }, [getActiveProjectDir, addMsg, startLogMsg, createProgressCallback, pipelineEventSink, finishLog, llmProvider]);

  const writeProtectedDataFromSource = useCallback(async (
    dataFile: string,
    dataSummary: string,
    onProgress?: (line: string) => void,
  ): Promise<void> => {
    const projectDir = getActiveProjectDir();
    if (!projectDir) return;
    const parsed = await DataParserService.parse(dataFile);
    const templateService = new TemplateService();
    const path = await templateService.writeProtectedDashboardData(projectDir, board.name, {
      rows: parsed.rows,
      headers: parsed.headers,
      format: parsed.format,
      summary: dataSummary,
      generatedAt: new Date().toISOString(),
    });
    onProgress?.(`Wrote protected dashboard data: ${path}`);
  }, [board.name, getActiveProjectDir]);

  const buildDoctorReport = useCallback((): string => {
    const config = new ConfigService();
    const projectDir = getActiveProjectDir();
    const info = projectDir ? projectManager.getProjectInfo(projectDir) : null;
    const dataFile = board.dataFiles[0];
    const historyCount = new PromptHistoryService().read(board.id).length;
    const hasDashboardCredentials = Boolean(
      config.get('credentials.username') &&
      config.getSecret('credentials.passwordHash') &&
      config.getSecret('credentials.jwtSecret'),
    );
    // GitHub/Vercel readiness only applies when the mode deploys remotely.
    const doctorMode = getAppMode(config);
    const remoteChecks: Array<[string, boolean]> = modeAllowsDeploy(doctorMode)
      ? [
          ['GitHub config', config.has('github.token') || config.has('github.username')],
          ['Vercel config/login path', config.has('vercel.token') || Boolean(info?.hasVercel)],
        ]
      : [];
    const checks = [
      ['LLM provider', Boolean(config.get('llm.provider'))],
      ...remoteChecks,
      ['Dashboard credentials', hasDashboardCredentials],
      ['Generated project', Boolean(projectDir && info?.hasPackageJson)],
      ['Dependencies installed', Boolean(info?.hasNodeModules)],
      ['Build output exists', Boolean(info?.hasDist)],
      ['Git initialized', Boolean(info?.hasGit)],
      ['Data source exists', Boolean(dataFile && existsSync(dataFile))],
      ['Prompt history exists', historyCount > 0],
    ];

    // Registry ↔ disk reconciliation: registered boards whose workspace is gone.
    const registryLines: string[] = [];
    try {
      const boards = new BoardRegistryService().listBoards();
      const orphaned = boards.filter((b) => b.outputDir && !existsSync(b.outputDir));
      registryLines.push(`Registered dashboards: ${boards.length}`);
      if (orphaned.length > 0) {
        registryLines.push(`WARN ${orphaned.length} dashboard(s) point at missing project dirs:`);
        for (const b of orphaned) registryLines.push(`  - ${b.name}: ${b.outputDir}`);
      } else {
        registryLines.push('OK Registry matches disk: all project dirs exist');
      }
    } catch {
      registryLines.push('Registry reconciliation unavailable.');
    }

    // Run history: success rate, failure hot spots, recorded token usage.
    const runLines: string[] = [];
    try {
      const summary = new RunStateService().summarize();
      if (summary.total > 0) {
        runLines.push(`Runs (last ${summary.total}): ${summary.succeeded} succeeded, ${summary.failed} failed`);
        const phases = Object.entries(summary.failuresByPhase).sort((a, b) => b[1] - a[1]);
        if (phases.length > 0) {
          runLines.push(`Failures by phase: ${phases.map(([phase, count]) => `${phase}=${count}`).join(', ')}`);
        }
        if (summary.totalTokens > 0) {
          runLines.push(`LLM tokens recorded: ${summary.totalTokens.toLocaleString()}`);
        }
      } else {
        runLines.push('No recorded pipeline runs yet.');
      }
    } catch {
      runLines.push('Run history unavailable.');
    }

    return [
      'OpenBoardCLI Doctor',
      `Mode: ${describeAppMode(doctorMode)}`,
      ...checks.map(([label, ok]) => `${ok ? 'OK' : 'WARN'} ${label}: ${yesNo(Boolean(ok))}`),
      '',
      ...registryLines,
      '',
      ...runLines,
      '',
      `Project: ${projectDir || 'not set'}`,
      `Data: ${dataFile || 'not linked'}`,
      `Prompt history entries: ${historyCount}`,
    ].join('\n');
  }, [board.id, board.dataFiles, getActiveProjectDir]);

  const buildHistoryReport = useCallback((): string => {
    const history = new PromptHistoryService().read(board.id);
    if (history.length === 0) {
      return 'No prompt history found for this dashboard.';
    }

    const recent = history.slice(-8).map((entry, index) => {
      const prompt = entry.prompt.length > 140 ? `${entry.prompt.slice(0, 137)}...` : entry.prompt;
      return `${index + 1}. [${entry.source}] ${entry.createdAt}\n   ${prompt}\n   Files: ${entry.writtenFiles.join(', ') || 'none'}`;
    });

    return [`Prompt history for ${board.title}`, ...recent].join('\n');
  }, [board.id, board.title]);

  const runBuildPushDeploy = useCallback(
    async (
      projectDir: string,
      label: string,
      cancelOptions: { signal?: AbortSignal; run?: RunRecord } = {},
    ): Promise<void> => {
      const { signal, run } = cancelOptions;
      const runs = new RunStateService();
      setIsLoading(true);
      const logId = startLogMsg(label);
      const reporter = makePipelineReporter(createProgressCallback(logId));
      const onProgress = reporter.progress;
      opPhasesRef.current = ['build', 'push', 'deploy', 'done'];

      try {
        reporter.phase('build');
        if (run) runs.markPhase(run, 'build');
        onProgress('Running pre-deploy checks...');
        const preDeploy = projectManager.preDeployChecks(projectDir, onProgress);
        if (!preDeploy.success) {
          onProgress(`Pre-deploy checks failed: ${preDeploy.error}`);
          if (run) runs.fail(run, preDeploy.error ?? 'Pre-deploy checks failed');
          return;
        }

        const info = projectManager.getProjectInfo(projectDir);
        if (info && !info.hasNodeModules) {
          onProgress('Installing dependencies...');
          const installResult = await projectManager.install(projectDir, onProgress, signal);
          if (!installResult.success) {
            onProgress(`Install failed: ${installResult.error}`);
            if (run) runs.fail(run, installResult.error ?? 'Install failed');
            return;
          }
        }

        try {
          const synced = await new TemplateService().syncShellFiles(projectDir);
          onProgress(`Refreshed ${synced.length} app frame file(s).`);
        } catch (error: any) {
          onProgress(`Warning: app frame refresh skipped: ${error.message}`);
        }

        // Keep the master Overview tab in sync with the registered dashboards
        // (no-op when unchanged; failures are non-fatal inside syncMasterTab).
        await new DashboardUpdateService().syncMasterTab(projectDir, reporter);
        await syncDashboardManifest(projectDir, onProgress);

        onProgress('Building project...');
        const buildResult = await projectManager.build(projectDir, onProgress, signal);
        if (!buildResult.success) {
          onProgress(`Build failed: ${buildResult.error}`);
          if (run) runs.fail(run, buildResult.error ?? 'Build failed');
          return;
        }
        onProgress('Build successful');

        const mode = getAppMode();
        if (!modeAllowsDeploy(mode)) {
          onProgress(`Mode is ${mode} — GitHub push and Vercel deploy are skipped by design.`);
          onProgress('Run /preview to view the updated dashboard locally.');
          reporter.phase('done');
          if (run) runs.complete(run, { projectDir });
          return;
        }

        reporter.phase('push');
        if (run) runs.markPhase(run, 'push');
        onProgress('Pushing to GitHub...');
        const pushResult = await projectManager.commitAndPush(
          projectDir,
          `Update: ${new Date().toISOString()}`,
          onProgress,
          signal,
        );

        if (!pushResult.success) {
          onProgress(`GitHub push skipped/failed: ${pushResult.error || 'Unknown error'}`);
          onProgress('Continuing with Vercel deployment...');
        } else {
          const repoInfo = pushResult.repoUrl ? ` -> ${pushResult.repoUrl}` : '';
          onProgress(`Pushed to GitHub (${pushResult.commitHash?.slice(0, 7)})${repoInfo}`);
        }

        reporter.phase('deploy');
        if (run) runs.markPhase(run, 'deploy');
        onProgress('Deploying to Vercel...');
        const deployResult = await projectManager.deploy(projectDir, onProgress, signal);
        reportDeployResult(deployResult, pushResult.success && pushResult.pushed === true, onProgress);
        reporter.phase('done');
        if (run) runs.complete(run, { projectDir, deployUrl: deployResult.url });
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          onProgress('⏹ Stopped by user.');
        } else {
          onProgress(`Pipeline error: ${error.message}`);
          if (run) runs.fail(run, error.message);
        }
      } finally {
        setPipeline(null);
        finishLog(logId);
        setIsLoading(false);
      }
    },
    [createProgressCallback, finishLog, startLogMsg, makePipelineReporter],
  );

  /**
   * Build the LLM context messages from chat history.
   * Includes system prompt, board context, and recent conversation.
   */
  const buildLLMContext = useCallback(
    (userText: string): LLMMessage[] => {
      const contextMessages: LLMMessage[] = [];

      // System prompt with board context and data analysis
      let boardContext = `\nCurrent board: "${board.title}" (type: ${board.type})
Output directory: ${getActiveProjectDir() || 'not set'}
Data files: ${board.dataFiles.length > 0 ? board.dataFiles.join(', ') : 'none'}
Generated components: ${board.components.length > 0 ? board.components.join(', ') : 'none'}`;

      if (board.dataSummary) {
        boardContext += `\n\nDATA ANALYSIS (use this to generate relevant charts and metrics):\n${board.dataSummary}`;
      }

      try {
        const registry = new BoardRegistryService();
        const boards = registry.listBoards();
        if (boards.length > 0) {
          boardContext += `\n\nOPENBOARD WORKSPACE MODE:
This generated React app is a single authenticated UI that can contain multiple dashboards as separate tabs.
Existing registered dashboards:
${boards.map((b) => `- ${b.title} (${b.name}, ${b.type})`).join('\n')}

For the current board "${board.title}":
- Return ONLY this board's dashboard component(s) (e.g. components/${board.title.replace(/[^A-Za-z0-9]/g, '')}Dashboard.tsx) and any helper files they need.
- Do NOT return App.tsx, generated/dashboardManifest.tsx, tab/navigation code, authentication files, components/MasterDashboard.tsx, or components/ErrorBoundary.tsx — OpenBoardCLI owns the app shell and registers dashboard tabs automatically at build time.
- Do not rename the app/header to "${board.title}". Use "${board.title}" only as a content heading.
- Prefer dashboard-specific component names and files so additions do not overwrite other dashboards.`;
        }
      } catch {
        // Registry/current app context is helpful but not required for generation.
      }

      contextMessages.push({
        role: 'system',
        content: (board.uiQuality === 'low' ? SYSTEM_PROMPT_LOW : SYSTEM_PROMPT) + boardContext,
      });

      // Include recent chat history for context continuity
      const recentMessages = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-MAX_CONTEXT_MESSAGES);

      for (const msg of recentMessages) {
        contextMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }

      // Current user message
      contextMessages.push({ role: 'user', content: userText });

      return contextMessages;
    },
    [board, messages],
  );

  /**
   * Write extracted files from an LLM response to the project directory.
   */
  const writeExtractedFiles = useCallback(
    async (content: string): Promise<string[]> => {
      const projectDir = getActiveProjectDir();
      if (!projectDir) return [];

      const extracted = extractFiles(content);
      // Parity with the agent flow: App.tsx, generated/* (tab manifest), and
      // MasterDashboard are product-owned — a model response must never
      // overwrite them (the Overview is regenerated by syncMasterTab).
      const files = extracted.filter(
        (file) =>
          file.path !== 'App.tsx' &&
          !file.path.startsWith('generated/') &&
          file.path !== 'components/MasterDashboard.tsx' &&
          file.path !== 'components/ErrorBoundary.tsx',
      );
      if (files.length !== extracted.length) {
        addMsg(newMsg('system', 'Skipped App.tsx/layout files from the response — OpenBoardCLI manages the app layout, tabs, and Overview automatically.'));
      }
      if (files.length === 0) return [];

      const templateService = new TemplateService();
      const written: string[] = [];

      for (const file of files) {
        try {
          await templateService.writeGeneratedFile(projectDir, file.path, file.content);
          written.push(file.path);
        } catch (err: any) {
          addMsg(newMsg('error', `Failed to write ${file.path}: ${err.message}`));
        }
      }

      return written;
    },
    [getActiveProjectDir, addMsg],
  );

  /**
   * Send a message to the LLM and stream the response.
   */
  const sendToLLM = useCallback(
    async (text: string, options: SendToLLMOptions = {}): Promise<string[]> => {
      if (!llmProvider) {
        addMsg(
          newMsg(
            'error',
            llmError || 'LLM not configured. Run setup wizard first (/config).',
          ),
        );
        setIsLoading(false);
        return [];
      }

      const contextMessages = buildLLMContext(text);

      // Create a placeholder streaming message
      const streamMsg = newMsg('assistant', '', true);
      addMsg(streamMsg);
      streamingMsgRef.current = streamMsg.id;
      // A local model's *total* context (prompt + completion) is often small —
      // trimming the system prompt alone isn't enough if the completion budget
      // still assumes a large-context provider.
      const maxTokens = board.uiQuality === 'low' ? 4096 : 8192;

      try {
        let fullContent = '';
        let receivedContent = false;

        // Liveness ticker. Some providers (notably openai-codex) buffer the
        // whole response and emit nothing until done — with no feedback the
        // chat looks frozen at an empty "LLM:" line. Show an elapsed-time
        // placeholder until the first real text arrives.
        const startedAt = Date.now();
        const liveTicker = setInterval(() => {
          if (receivedContent) return;
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          updateStreamingMsg(
            streamMsg.id,
            `⏳ Generating with ${llmProvider.name}… ${elapsed}s elapsed (large models can take a few minutes)`,
            false,
          );
        }, 1000);

        try {
          // Stream the response from the LLM
          for await (const chunk of llmProvider.stream({
            messages: contextMessages,
            temperature: 0.7,
            maxTokens,
            signal: options.signal,
          })) {
            if (chunk.text) receivedContent = true;
            fullContent += chunk.text;
            updateStreamingMsg(streamMsg.id, fullContent, chunk.done);

            if (chunk.done) break;
          }

          // If streaming produced no content, fall back to complete()
          if (!fullContent.trim()) {
            fullContent = await llmProvider.complete({
              messages: contextMessages,
              temperature: 0.7,
              maxTokens,
              signal: options.signal,
            });
            receivedContent = true;
            updateStreamingMsg(streamMsg.id, fullContent, true);
          }
        } finally {
          clearInterval(liveTicker);
        }

        // A provider or proxy can return an error as a "successful" completion
        // (e.g. a gateway echoing an upstream failure). Don't present that as
        // the model's reply or mine it for files — surface it as an error.
        if (isErrorShapedContent(fullContent)) {
          updateStreamingMsg(streamMsg.id, 'Generation failed — see the error below.', true);
          addMsg(newMsg('error', describeLLMError(fullContent, llmProvider?.name)));
          return [];
        }

        // Extract and write any code files from the response
        const writtenFiles = await writeExtractedFiles(fullContent);
        if (writtenFiles.length > 0) {
          if (options.recordPrompt !== false) {
            try {
              new PromptHistoryService().append({
                boardId: board.id,
                boardName: board.name,
                boardTitle: board.title,
                source: options.promptSource ?? 'manual',
                prompt: text,
                writtenFiles,
                dataSummary: options.dataSummary ?? board.dataSummary,
              });

              new BoardRegistryService().upsertBoard({
                ...board,
                outputDir: getActiveProjectDir(),
                components: [...new Set([...board.components, ...writtenFiles])],
                generatedAt: new Date().toISOString(),
              });
            } catch {
              // Prompt history is best-effort; generated files remain written.
            }
          }
          addMsg(
            newMsg('system', `📁 Written ${writtenFiles.length} file(s): ${writtenFiles.join(', ')}\nRun "/preview" to see changes.`),
          );
        } else if (/\/\/CODE_START|---\s*FILE:|```/.test(fullContent)) {
          // The response looked like code but no complete file block could be
          // extracted (usually a truncated response or missing end markers).
          addMsg(
            newMsg('system', '⚠ The response contained code but no complete file blocks were extracted, so no files were written. This usually means the response was truncated or skipped the FILE markers — try asking again.'),
          );
        }
        return writtenFiles;
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          updateStreamingMsg(streamMsg.id, '⏹ Stopped by user.', true);
          return [];
        }
        const rawMessage = err.message || 'Unknown LLM error';
        // One friendly error message; the assistant bubble only notes the failure.
        updateStreamingMsg(streamMsg.id, 'Generation failed — see the error below.', true);
        addMsg(newMsg('error', describeLLMError(rawMessage, llmProvider?.name)));
        return [];
      } finally {
        streamingMsgRef.current = null;
        setIsLoading(false);
      }
    },
    [llmProvider, llmError, addMsg, updateStreamingMsg, buildLLMContext, writeExtractedFiles, board, getActiveProjectDir],
  );

  // ── Announce scheduled invoice fetches ────────────────────────────────────
  // A scheduled fetch is the only work here the user did not trigger, so it has
  // to announce itself. Only runs whose start was observed in this session are
  // announced — the scheduler emits the persisted lastRunAt on startup, and
  // reporting that would claim a previous session's fetch as a fresh one.
  const sawBillerRunRef = useRef(false);
  const announcedBillerRunRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!billerStatus) return;
    if (billerStatus.state === 'running') {
      sawBillerRunRef.current = true;
      return;
    }
    if (!sawBillerRunRef.current) return;

    if (billerStatus.state === 'error') {
      const stamp = billerStatus.lastRunAt ?? billerStatus.error;
      if (!stamp || stamp === announcedBillerRunRef.current) return;
      announcedBillerRunRef.current = stamp;
      addMsg(newMsg('error', `Scheduled invoice fetch failed: ${billerStatus.error ?? 'unknown error'}`));
      return;
    }

    const runAt = billerStatus.lastRunAt;
    if (!runAt || runAt === announcedBillerRunRef.current) return;
    announcedBillerRunRef.current = runAt;
    const changed = billerStatus.changedKeys ?? [];
    addMsg(newMsg('system', changed.length > 0
      ? `Scheduled invoice fetch finished — new invoices for ${changed.join(', ')}; dashboards refreshed.`
      : 'Scheduled invoice fetch finished — no new invoices.'));
  }, [billerStatus, addMsg]);

  // ── Auto-generate initial dashboard when entering chat with data ──────────
  useEffect(() => {
    if (!autoGenerateInitial) return;
    if (autoGenTriggered.current) return;
    if (!llmProvider || !board.dataSummary || !getActiveProjectDir()) return;

    autoGenTriggered.current = true;
    const featureClause = board.uiQuality === 'low'
      ? 'Keep it simple: 1-3 KPI/metric cards and exactly one chart is enough — prioritize finishing complete, valid code over feature richness.'
      : 'Include at least 2-3 charts and some metric/stat cards.';
    const autoPrompt = `Generate an initial dashboard tab for "${board.title}" (${board.type} type) inside the existing OpenBoardCLI master React app. Based on my data analysis, create appropriate metric cards, charts, and visualizations. Load real rows with useProtectedDashboardData('${board.name}') from src/hooks/useProtectedDashboardData.ts. Do not embed raw source rows or sensitive data in frontend code. Use the column names and data types from the analysis to pick the best chart types. ${featureClause} Return only this dashboard's component files — OpenBoardCLI registers the tab automatically at build time; do not return App.tsx or navigation code. Keep the centered master header text exactly "OpenBoardCLI"; do not replace it with "${board.title}".`;

    addMsg(newMsg('system', 'Auto-generating initial dashboard from your data...'));
    setIsLoading(true);
    (async () => {
      try {
        if (board.dataFiles[0] && board.dataSummary) {
          await writeProtectedDataFromSource(board.dataFiles[0], board.dataSummary);
        }
        await sendToLLM(autoPrompt, {
          recordPrompt: true,
          promptSource: 'initial',
          dataSummary: board.dataSummary,
        });
      } catch (error: any) {
        addMsg(newMsg('error', `Initial dashboard generation failed: ${error.message}`));
        setIsLoading(false);
      }
    })();
  }, [autoGenerateInitial, llmProvider, board, addMsg, sendToLLM, getActiveProjectDir, writeProtectedDataFromSource]);

  const handleSubmit = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      // /stop must be able to interrupt whatever is already in flight, so it
      // alone is exempt from the isLoading gate below.
      if (isLoading && !/^\/stop$/i.test(text.trim())) return;
      setInput('');
      setScrollOffset(0); // sending snaps the chat back to the latest message

      const userMsg = newMsg('user', text);
      addMsg(userMsg);

      // Handle pending confirmation for destructive actions. /stop is exempt —
      // otherwise it's swallowed here as "not yes" (shows "Cancelled." while a
      // confirmed deploy/push pipeline keeps running in the background) and
      // never reaches the actual cmd.type === 'stop' handler below.
      if (pendingConfirm && !/^\/stop$/i.test(text.trim())) {
        const confirmed = text.toLowerCase() === 'yes' || text.toLowerCase() === 'y';
        if (confirmed) {
          const projectDir = getActiveProjectDir();
          if (!projectDir) {
            addMsg(newMsg('error', 'No project directory. Create a board first.'));
            setPendingConfirm(null);
            return;
          }

          if (pendingConfirm === 'deploy') {
            setIsLoading(true);
            const deployController = new AbortController();
            activeAbortRef.current = deployController;
            const logId = startLogMsg('Confirmed. Starting full deploy pipeline...');
            const reporter = makePipelineReporter(createProgressCallback(logId));
            const onProgress = reporter.progress;
            opPhasesRef.current = ['build', 'push', 'deploy', 'done'];

            try {
              reporter.phase('build');
              onProgress('Running pre-deploy checks...');
              const preDeploy = projectManager.preDeployChecks(projectDir, onProgress);
              if (!preDeploy.success) {
                onProgress(`Pre-deploy checks failed: ${preDeploy.error}`);
                setPipeline(null);
                finishLog(logId);
                setIsLoading(false);
                setPendingConfirm(null);
                return;
              }

              try {
                const synced = await new TemplateService().syncShellFiles(projectDir);
                onProgress(`Refreshed ${synced.length} app frame file(s).`);
              } catch (error: any) {
                onProgress(`Warning: app frame refresh skipped: ${error.message}`);
              }

              // Keep the master Overview tab in sync with the registered
              // dashboards (no-op when unchanged; failures are non-fatal).
              await new DashboardUpdateService().syncMasterTab(projectDir, reporter);
              await syncDashboardManifest(projectDir, onProgress);

              // Step 1: Build the project
              onProgress('Building project...');
              const buildResult = await projectManager.build(projectDir, onProgress, deployController.signal);

              if (!buildResult.success) {
                onProgress(`Build failed: ${buildResult.error}`);
                setPipeline(null);
                finishLog(logId);
                setIsLoading(false);
                setPendingConfirm(null);
                return;
              }
              onProgress('Build successful');

              // Step 2: Commit and push to GitHub
              reporter.phase('push');
              onProgress('Pushing to GitHub...');
              const pushResult = await projectManager.commitAndPush(
                projectDir,
                `Deploy: ${new Date().toISOString()}`,
                onProgress,
                deployController.signal,
              );

              if (!pushResult.success) {
                onProgress(`GitHub push failed: ${pushResult.error || 'Unknown error'}`);
                onProgress('Continuing with Vercel deployment...');
              } else {
                const repoInfo = pushResult.repoUrl ? ` -> ${pushResult.repoUrl}` : '';
                onProgress(`Pushed to GitHub (${pushResult.commitHash?.slice(0, 7)})${repoInfo}`);
              }

              // Step 3: Deploy to Vercel
              reporter.phase('deploy');
              onProgress('Deploying to Vercel...');
              const deployResult = await projectManager.deploy(projectDir, onProgress, deployController.signal);
              reportDeployResult(deployResult, pushResult.success && pushResult.pushed === true, onProgress);

              reporter.phase('done');
              setPipeline(null);
              finishLog(logId);
              setIsLoading(false);
            } catch (error: any) {
              onProgress(error?.name === 'AbortError' ? '⏹ Stopped by user.' : `Deploy pipeline error: ${error.message}`);
              setPipeline(null);
              finishLog(logId);
              setIsLoading(false);
            } finally {
              if (activeAbortRef.current === deployController) activeAbortRef.current = null;
            }
          } else if (pendingConfirm === 'push') {
            setIsLoading(true);
            const pushController = new AbortController();
            activeAbortRef.current = pushController;
            const logId = startLogMsg('Confirmed. Committing and pushing to GitHub...');
            const onProgress = createProgressCallback(logId);

            try {
              const result = await projectManager.commitAndPush(
                projectDir,
                `Update: ${new Date().toISOString()}`,
                onProgress,
                pushController.signal,
              );

              if (!result.success) {
                onProgress(`Push failed: ${result.error}`);
              } else {
                const repoInfo = result.repoUrl ? ` -> ${result.repoUrl}` : '';
                onProgress(`Pushed to GitHub (commit: ${result.commitHash?.slice(0, 7)})${repoInfo}`);
                onProgress('Run /deploy to publish the live app.');
              }

              finishLog(logId);
              setIsLoading(false);
            } catch (error: any) {
              onProgress(error?.name === 'AbortError' ? '⏹ Stopped by user.' : `Error: ${error.message}`);
              finishLog(logId);
              setIsLoading(false);
            } finally {
              if (activeAbortRef.current === pushController) activeAbortRef.current = null;
            }
          }
        } else {
          addMsg(newMsg('system', 'Cancelled.'));
        }
        setPendingConfirm(null);
        return;
      }

      const cmd = parseCommand(text);

      if (cmd.type === 'commands') {
        addMsg(newMsg('system', `Command palette\n${commandsTextForMode(modeAllowsDeploy(getAppMode()))}`));
        return;
      }

      // ── /help ──────────────────────────────────────────────────────────────
      if (cmd.type === 'help') {
        addMsg(newMsg('system', helpTextForMode(modeAllowsDeploy(getAppMode()))));
        return;
      }

      // ── /model — show or switch the LLM model + execution effort ──────────
      if (cmd.type === 'model') {
        const config = new ConfigService();
        const provider = config.get('llm.provider') as LLMProviderName | undefined;
        if (!provider) {
          addMsg(newMsg('error', 'No LLM provider configured. Run setup first (/config).'));
          return;
        }

        if (cmd.args.length === 0) {
          const currentModel = llmMeta?.model ?? getDefaultModel(provider);
          const currentEffort = llmMeta?.effort ?? DEFAULT_EFFORT;

          let modelsHeading = 'Available models:';
          let models: string;
          if (provider === 'ollama' || provider === 'lmstudio') {
            const host = provider === 'ollama'
              ? (config.get('llm.ollamaHost') as string | undefined) ?? 'http://127.0.0.1:11434'
              : (config.get('llm.baseUrl') as string | undefined) ?? 'http://127.0.0.1:1234/v1';
            const result = await fetchInstalledModels(provider, host);
            if (result.status === 'ok') {
              modelsHeading = `Installed models (live from ${provider === 'ollama' ? 'Ollama' : 'LM Studio'}):`;
              models = result.models
                .map((m) => `  - ${m.value}${m.value === currentModel ? '  (current)' : ''}`)
                .join('\n');
            } else {
              modelsHeading = `${result.message}\n\nSuggested models (not verified installed):`;
              models = (MODEL_CHOICES[provider] ?? [])
                .map((c) => `  - ${c.value}${c.value === currentModel ? '  (current)' : ''}`)
                .join('\n');
            }
          } else {
            models = (MODEL_CHOICES[provider] ?? [])
              .map((c) => `  - ${c.value}${c.value === currentModel ? '  (current)' : ''}`)
              .join('\n') || '  (enter any model name for this provider)';
          }

          addMsg(newMsg(
            'system',
            `Provider: ${provider}\nModel: ${currentModel}\nEffort: ${currentEffort}\n\n${modelsHeading}\n${models}\n\nEffort levels: ${LLM_EFFORTS.join(', ')}\n\nUsage:\n  /model <model>            switch model\n  /model <model> <effort>   switch model + effort\n  /model effort <effort>    switch effort only`,
          ));
          return;
        }

        const [first, second] = cmd.args;
        let newModel: string | undefined;
        let newEffort: LLMEffort | undefined;
        if (first.toLowerCase() === 'effort') {
          const level = second?.toLowerCase();
          if (!isValidEffort(level)) {
            addMsg(newMsg('error', `Invalid effort "${second ?? ''}". Use one of: ${LLM_EFFORTS.join(', ')}.`));
            return;
          }
          newEffort = level;
        } else {
          newModel = first;
          if (second) {
            const level = second.toLowerCase();
            if (!isValidEffort(level)) {
              addMsg(newMsg('error', `Invalid effort "${second}". Use one of: ${LLM_EFFORTS.join(', ')}.`));
              return;
            }
            newEffort = level;
          }
        }

        try {
          if (newModel) config.set('llm.model', newModel);
          if (newEffort) config.set('llm.effort', newEffort);
          initLLMFromConfig();
          const finalModel = newModel ?? llmMeta?.model ?? getDefaultModel(provider);
          const finalEffort = newEffort ?? llmMeta?.effort ?? DEFAULT_EFFORT;
          let knownModelValues = (MODEL_CHOICES[provider] ?? []).map((c) => c.value);
          if (newModel && (provider === 'ollama' || provider === 'lmstudio')) {
            const host = provider === 'ollama'
              ? (config.get('llm.ollamaHost') as string | undefined) ?? 'http://127.0.0.1:11434'
              : (config.get('llm.baseUrl') as string | undefined) ?? 'http://127.0.0.1:1234/v1';
            const result = await fetchInstalledModels(provider, host);
            if (result.status === 'ok') knownModelValues = result.models.map((m) => m.value);
          }
          const unknownNote = newModel && knownModelValues.length > 0 && !knownModelValues.includes(newModel)
            ? `\nNote: "${newModel}" was not found in the ${provider === 'ollama' || provider === 'lmstudio' ? 'live model list' : `known ${provider} model list`} — make sure it exists.`
            : '';
          addMsg(newMsg('system', `LLM updated: ${provider} · ${finalModel} · effort: ${finalEffort}. Takes effect on the next LLM call.${unknownNote}`));
        } catch (error: any) {
          addMsg(newMsg('error', `Failed to update model: ${error.message}`));
        }
        return;
      }

      if (cmd.type === 'doctor') {
        addMsg(newMsg('system', buildDoctorReport()));
        return;
      }

      if (cmd.type === 'logs') {
        addMsg(newMsg('system', lastOperationLogRef.current.trim() || 'No operation log is available yet.'));
        return;
      }

      if (cmd.type === 'unknown') {
        addMsg(newMsg('system', formatUnknownCommandMessage(cmd.text, cmd.suggestions)));
        return;
      }

      if (cmd.type === 'history') {
        addMsg(newMsg('system', buildHistoryReport()));
        return;
      }

      if (cmd.type === 'data') {
        const dataFile = board.dataFiles[0];
        if (!dataFile) {
          addMsg(newMsg('error', 'No data source is linked to this dashboard.'));
          return;
        }

        setIsLoading(true);
        const logId = startLogMsg(`Reading data source: ${dataFile}`);
        const onProgress = createProgressCallback(logId);
        try {
          const parsed = await DataParserService.parse(dataFile);
          const analysis = DataAnalyzer.analyze(parsed);
          onProgress(`Rows: ${analysis.rowCount}`);
          onProgress(`Columns: ${analysis.columnCount}`);
          onProgress(`Format: ${parsed.format}`);
          onProgress(`Modified: ${fileModifiedAt(dataFile)}`);
          onProgress('');
          onProgress('Columns:');
          for (const column of analysis.columns) {
            onProgress(`- ${column.name} (${column.type})${column.isCategorical ? ' categorical' : ''}`);
          }
        } catch (error: any) {
          onProgress(`Data check failed: ${error.message}`);
        } finally {
          finishLog(logId);
          setIsLoading(false);
        }
        return;
      }

      // ── /billers ───────────────────────────────────────────────────────────
      if (cmd.type === 'billers') {
        const sub = cmd.args[0]?.toLowerCase();
        const settings = new TypedConfigRepository().getBillerSettings();
        const fetcher = new BillerFetcherService();

        if (!settings.scriptsDir) {
          addMsg(newMsg('system', 'Invoice fetchers are not set up. Open Settings › Invoice fetchers (/config) to point OpenBoardCLI at your fetcher scripts.'));
          return;
        }

        const discovered = fetcher.list();

        if (sub === undefined) {
          const lines = [
            `Invoice fetchers: ${discovered.length} found in ${settings.scriptsDir}`,
            `Gmail account: ${settings.email ?? 'not set'}${settings.appPassword ? '' : ' (App Password missing)'}`,
            `Interval: every ${settings.syncIntervalMinutes} min · Last run: ${settings.lastRunAt ? new Date(settings.lastRunAt).toLocaleString() : 'never'}`,
            '',
            ...discovered.map((biller) => `  ${settings.enabledKeys.includes(biller.key) ? '[x]' : '[ ]'} ${biller.key.padEnd(18)} ${biller.displayName}`),
            '',
            'Usage: /billers sync runs the enabled ones · /billers enable|disable <key> toggles one',
          ];
          addMsg(newMsg('system', lines.join('\n')));
          return;
        }

        if (sub === 'enable' || sub === 'disable') {
          const key = cmd.args[1];
          if (!key) {
            addMsg(newMsg('error', `Which biller? Usage: /billers ${sub} <key> — run /billers to list the keys.`));
            return;
          }
          if (!discovered.some((biller) => biller.key === key)) {
            addMsg(newMsg('error', `No fetcher named "${key}". Run /billers to see the available keys.`));
            return;
          }
          const enabled = new Set(settings.enabledKeys);
          if (sub === 'enable') enabled.add(key);
          else enabled.delete(key);
          new ConfigService().set('billers.enabledKeys', [...enabled]);
          addMsg(newMsg('system', `${sub === 'enable' ? 'Enabled' : 'Disabled'} ${key}. Takes effect on the next scheduled run or /billers sync.`));
          return;
        }

        if (sub === 'sync') {
          if (!settings.email || !settings.appPassword) {
            addMsg(newMsg('error', 'Gmail address and App Password are required. Open Settings › Invoice fetchers (/config).'));
            return;
          }
          const controller = new AbortController();
          activeAbortRef.current = controller;
          setIsLoading(true);
          const logId = startLogMsg('Running enabled invoice fetchers…');
          const onProgress = createProgressCallback(logId);
          try {
            const results = await fetcher.syncEnabled({ onProgress, signal: controller.signal });
            if (results.skipped === 'locked') return;
            if (results.length === 0) {
              onProgress('No billers are enabled — use /billers enable <key> first.');
            }
            // Same work a scheduled tick does, so it re-anchors the schedule.
            // Without this the running scheduler still judged itself overdue and
            // fired a duplicate fetch moments after this one finished.
            if (shouldAnchorRun(results)) recordBillerRun();
            for (const result of results) {
              onProgress(result.ok
                ? `${result.displayName}: ${result.changed ? 'new invoices' + (result.dashboardUpdated ? ' — dashboard refreshed' : '') : 'no new invoices'}`
                : `${result.displayName}: ${result.error}`);
            }
          } catch (error: any) {
            onProgress(error?.name === 'AbortError' ? '⏹ Stopped by user.' : `Fetch failed: ${error.message}`);
          } finally {
            if (activeAbortRef.current === controller) activeAbortRef.current = null;
            finishLog(logId);
            setIsLoading(false);
          }
          return;
        }

        addMsg(newMsg('error', `Unknown /billers option "${cmd.args[0]}". Use /billers, /billers sync, or /billers enable|disable <key>.`));
        return;
      }

      // ── /status ────────────────────────────────────────────────────────────
      if (cmd.type === 'status') {
        const providerInfo = llmProvider
          ? `LLM: ${llmProvider.name}`
          : `LLM: ${llmError || 'not configured'}`;
        const activeProjectDir = getActiveProjectDir();
        const info = activeProjectDir ? projectManager.getProjectInfo(activeProjectDir) : null;
        const projectStatus = info
          ? `Project: ${activeProjectDir}\n  Installed: ${info.hasNodeModules ? 'yes' : 'no'} | Built: ${info.hasDist ? 'yes' : 'no'} | Git: ${info.hasGit ? 'yes' : 'no'}`
          : 'Project: not scaffolded';
        let tokenInfo = '';
        try {
          const summary = new RunStateService().summarize();
          if (summary.totalTokens > 0) {
            tokenInfo = `\nLLM tokens recorded across runs: ${summary.totalTokens.toLocaleString()}`;
          }
        } catch {
          // run history optional
        }
        addMsg(
          newMsg(
            'system',
            `Board: ${board.name}\nType: ${board.type}\n${projectStatus}\nDeploy URL: ${
              board.deployUrl ?? 'Not deployed'
            }\nComponents: ${board.components.join(', ') || 'None generated'}\n${providerInfo}${tokenInfo}`,
          ),
        );
        return;
      }

      // ── /config ────────────────────────────────────────────────────────────
      if (cmd.type === 'config') {
        onNavigate?.('settings');
        return;
      }

      // ── stop ───────────────────────────────────────────────────────────────
      if (cmd.type === 'stop') {
        if (!isLoading || !activeAbortRef.current) {
          addMsg(newMsg('system', 'Nothing is currently running.'));
          return;
        }
        activeAbortRef.current.abort();
        activeAbortRef.current = null;
        if (streamingMsgRef.current) {
          updateStreamingMsg(streamingMsgRef.current, '⏹ Stopped by user.', true);
        }
        if (logMsgRef.current) {
          appendLog(logMsgRef.current, '⏹ Stopped by user.');
        }
        if (activeRunRef.current) {
          new RunStateService().cancel(activeRunRef.current, 'Stopped by user');
          activeRunRef.current = null;
          addMsg(newMsg('system', `Stopped. Run /resume to pick "${board.title}" back up later.`));
        } else {
          addMsg(newMsg('system', 'Stopped.'));
        }
        return;
      }

      // ── resume ─────────────────────────────────────────────────────────────
      if (cmd.type === 'resume') {
        const runsService = new RunStateService();
        const allRuns = runsService.list(50);
        const candidate = allRuns
          .filter((r) => r.boardId === board.id && r.status !== 'succeeded')
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

        if (!candidate) {
          const elsewhere = allRuns.find((r) => r.boardId && r.boardId !== board.id && r.status !== 'succeeded');
          addMsg(newMsg(
            'system',
            elsewhere
              ? `No stopped or failed task found for "${board.title}". "${elsewhere.boardName ?? elsewhere.boardId}" has one — switch to that dashboard and run /resume there.`
              : 'No stopped or failed task found for this dashboard.',
          ));
          return;
        }

        setIsLoading(true);
        const controller = new AbortController();
        activeAbortRef.current = controller;
        activeRunRef.current = candidate;
        const logId = startLogMsg(`Resuming "${board.title}" (${candidate.status} at ${candidate.currentPhase ?? 'start'})...`);
        const onProgress = createProgressCallback(logId);

        try {
          const result = await new DashboardUpdateService().resume(candidate.runId, onProgress, controller.signal);
          if (result.success) {
            onProgress(`Resumed successfully.${result.deployUrl ? ` Deployed: ${result.deployUrl}` : ''}`);
          } else {
            onProgress(`Resume failed: ${result.error ?? 'Unknown error'}`);
          }
        } catch (error: any) {
          if (error?.name === 'AbortError') {
            onProgress('⏹ Stopped by user.');
          } else {
            onProgress(`Resume error: ${error.message}`);
          }
        } finally {
          finishLog(logId);
          setIsLoading(false);
          if (activeAbortRef.current === controller) activeAbortRef.current = null;
          activeRunRef.current = null;
        }
        return;
      }

      // ── build ──────────────────────────────────────────────────────────────
      if (cmd.type === 'build') {
        const projectDir = getActiveProjectDir();
        if (!projectDir) {
          addMsg(newMsg('error', 'No project directory. Create a board first.'));
          return;
        }
        setIsLoading(true);
        const buildController = new AbortController();
        activeAbortRef.current = buildController;
        const logId = startLogMsg(`Building project in ${projectDir}...`);
        const reporter = makePipelineReporter(createProgressCallback(logId));
        const onProgress = reporter.progress;

        try {
          opPhasesRef.current = ['build', 'done'];
          reporter.phase('build');
          // Refresh the Overview tab and product-owned manifest so dashboards
          // generated in chat are registered before the build.
          await new DashboardUpdateService().syncMasterTab(projectDir, reporter);
          await syncDashboardManifest(projectDir, onProgress);
          const result = await projectCommands.build(projectDir, onProgress, buildController.signal);
          if (!result.success) onProgress(result.error ?? 'Build failed.');
          else onProgress('Build successful. Run /preview to view it locally.');

          setPipeline(null);
          finishLog(logId);
          setIsLoading(false);
        } catch (error: any) {
          onProgress(error?.name === 'AbortError' ? '⏹ Stopped by user.' : `Build error: ${error.message}`);
          setPipeline(null);
          finishLog(logId);
          setIsLoading(false);
        } finally {
          if (activeAbortRef.current === buildController) activeAbortRef.current = null;
        }
        return;
      }

      // ── update ─────────────────────────────────────────────────────────────
      if (cmd.type === 'update') {
        const projectDir = getActiveProjectDir();
        if (!projectDir) {
          addMsg(newMsg('error', 'No project directory. Create a board first.'));
          return;
        }

        const dataFile = board.dataFiles[0];
        if (!dataFile) {
          addMsg(newMsg('error', 'No data source is linked to this dashboard.'));
          return;
        }

        const history = new PromptHistoryService().read(board.id);
        if (history.length === 0) {
          addMsg(newMsg('error', 'No prompt history found for this dashboard. Make a manual LLM change first so OpenBoardCLI knows what to recreate on update.'));
          return;
        }

        setIsLoading(true);
        const updateController = new AbortController();
        activeAbortRef.current = updateController;
        const runs = new RunStateService();
        const logId = startLogMsg(`Updating "${board.title}" from latest data source...`);
        const reporter = makePipelineReporter(createProgressCallback(logId));
        const onProgress = reporter.progress;

        try {
          reporter.phase('parse');
          onProgress(`Reading data: ${dataFile}`);
          const parsed = await DataParserService.parse(dataFile);
          reporter.phase('analyze');
          const analysis = DataAnalyzer.analyze(parsed);
          const latestSummary = DataAnalyzer.generateSummary(analysis);
          onProgress(`Parsed latest data (${analysis.rowCount} rows, ${analysis.columnCount} columns)`);
          await writeProtectedDataFromSource(dataFile, latestSummary, onProgress);

          const updatedBoard = {
            ...board,
            outputDir: projectDir,
            dataSummary: latestSummary,
          };
          new BoardRegistryService().upsertBoard(updatedBoard);

          const promptHistory = history
            .map((entry, index) => `${index + 1}. [${entry.source}] ${entry.prompt}`)
            .join('\n\n');

          const updatePrompt = `Regenerate/update the "${board.title}" dashboard tab using the latest data source.

This is an OpenBoardCLI update run. The data file (CSV/Excel/JSON) may have changed, but the dashboard intent should remain the same as the saved prompt history.

Dashboard:
- Title: ${board.title}
- Name: ${board.name}
- Type: ${board.type}
- Data file: ${dataFile}

Latest data analysis:
${latestSummary}

Saved prompt history to preserve:
${promptHistory}

Requirements:
1. Preserve the same dashboard tab and user-requested insights represented by the prompt history.
2. Update metrics, charts, tables, and data processing to reflect the latest data analysis.
3. Preserve other dashboard tabs in the shared OpenBoardCLI app.
4. Keep the centered master header text exactly "OpenBoardCLI"; do not replace it with "${board.title}".
5. Load real dashboard rows with useProtectedDashboardData('${board.name}') from src/hooks/useProtectedDashboardData.ts.
6. Do NOT embed raw source rows or sensitive data in App.tsx, component files, or src/data files.
7. Return all changed files using the required //CODE_START format.${board.uiQuality === 'low' ? '\n8. Keep it simple: 1-3 KPI/metric cards and exactly one chart is enough — prioritize finishing complete, valid code over feature richness.' : ''}`;

          const run = runs.createRun('update', { dashboard: board.name, prompt: updatePrompt, dataFile });
          run.boardId = board.id;
          run.boardName = board.name;
          run.boardTitle = board.title;
          run.projectDir = projectDir;
          runs.save(run);
          activeRunRef.current = run;

          finishLog(logId);
          reporter.phase('generate');
          runs.markPhase(run, 'generate');
          const writtenFiles = await sendToLLM(updatePrompt, {
            recordPrompt: false,
            promptSource: 'update',
            dataSummary: latestSummary,
            signal: updateController.signal,
          });
          setPipeline(null);

          if (writtenFiles.length === 0) {
            // A /stop mid-generation also yields an empty writtenFiles list —
            // don't clobber the 'cancelled' record /stop already wrote.
            if (!updateController.signal.aborted) {
              addMsg(newMsg('error', 'Update did not write any files. Build/push/deploy skipped.'));
              runs.fail(run, 'Update did not write any files.');
            }
            setIsLoading(false);
            return;
          }

          run.writtenFiles = writtenFiles;
          runs.save(run);
          await runBuildPushDeploy(
            projectDir,
            `Building, pushing, and deploying "${board.title}" after data update...`,
            { signal: updateController.signal, run },
          );
        } catch (error: any) {
          if (error?.name === 'AbortError') {
            onProgress('⏹ Stopped by user.');
          } else {
            onProgress(`Update failed: ${error.message}`);
          }
          setPipeline(null);
          finishLog(logId);
          setIsLoading(false);
        } finally {
          if (activeAbortRef.current === updateController) activeAbortRef.current = null;
          activeRunRef.current = null;
        }
        return;
      }

      // ── deploy ─────────────────────────────────────────────────────────────
      if (cmd.type === 'deploy') {
        const mode = getAppMode();
        if (!modeAllowsDeploy(mode)) {
          addMsg(newMsg('system', blockedDeployMessage(mode, 'deploy')));
          return;
        }
        const projectDir = getActiveProjectDir();
        if (!projectDir) {
          addMsg(newMsg('error', 'No project directory. Create a board first.'));
          return;
        }
        addMsg(newMsg('system', `This will deploy ${projectDir} to production. Type "yes" to confirm or anything else to cancel.`));
        setPendingConfirm('deploy');
        return;
      }

      // ── push ───────────────────────────────────────────────────────────────
      if (cmd.type === 'push') {
        const mode = getAppMode();
        if (!modeAllowsDeploy(mode)) {
          addMsg(newMsg('system', blockedDeployMessage(mode, 'push')));
          return;
        }
        const projectDir = getActiveProjectDir();
        if (!projectDir) {
          addMsg(newMsg('error', 'No project directory. Create a board first.'));
          return;
        }
        addMsg(newMsg('system', `This will push ${projectDir} to GitHub. Type "yes" to confirm or anything else to cancel.`));
        setPendingConfirm('push');
        return;
      }

      // ── preview ────────────────────────────────────────────────────────────
      if (cmd.type === 'preview') {
        const projectDir = getActiveProjectDir();
        if (!projectDir) {
          addMsg(newMsg('error', 'No project directory. Create a board first.'));
          return;
        }
        setIsLoading(true);

        const isRestart = projectManager.isPreviewRunning(projectDir);
        const logId = startLogMsg(
          isRestart
            ? `Restarting preview server for ${projectDir}...`
            : `Starting local dev server for ${projectDir}...`,
        );
        const onProgress = createProgressCallback(logId);

        try {
          // Refresh the Overview tab and product-owned manifest so the preview
          // (dev server imports generated/dashboardManifest.tsx directly)
          // shows every registered dashboard, including ones just generated.
          await new DashboardUpdateService().syncMasterTab(projectDir, makePipelineReporter(onProgress));
          await syncDashboardManifest(projectDir, onProgress);
          const result = await projectCommands.preview(projectDir, onProgress);
          if (!result.success) onProgress(result.error ?? 'Preview failed.');
        } catch (error: any) {
          onProgress(`Preview error: ${error.message}`);
        }

        finishLog(logId);
        setIsLoading(false);
        return;
      }

      // ── LLM message ────────────────────────────────────────────────────────
      if (cmd.type === 'message') {
        setIsLoading(true);
        const msgController = new AbortController();
        activeAbortRef.current = msgController;

        if (allBoards) {
          await runModifyAll(text, msgController.signal);
          if (activeAbortRef.current === msgController) activeAbortRef.current = null;
          return;
        }

        // Track this as a resumable run (skip the very first auto-generated
        // message — there's no existing dashboard/prompt-history shape yet).
        let run: RunRecord | undefined;
        if (!autoGenerateInitial) {
          const runs = new RunStateService();
          run = runs.createRun('update', { dashboard: board.name, prompt: text, dataFile: board.dataFiles[0] });
          run.boardId = board.id;
          run.boardName = board.name;
          run.boardTitle = board.title;
          run.projectDir = getActiveProjectDir();
          runs.save(run);
          activeRunRef.current = run;
        }

        const writtenFiles = await sendToLLM(text, { signal: msgController.signal });
        if (run) {
          const runs = new RunStateService();
          if (writtenFiles.length > 0) {
            runs.complete(run, { writtenFiles });
          } else if (!msgController.signal.aborted) {
            // Conversational turn, not a generation task — nothing to resume,
            // so discard the speculative run record rather than marking it failed.
            runs.remove(run.runId);
          }
        }
        if (activeAbortRef.current === msgController) activeAbortRef.current = null;
        activeRunRef.current = null;
      }
    },
    [isLoading, board, onNavigate, addMsg, pendingConfirm, llmProvider, llmMeta, llmError, initLLMFromConfig, sendToLLM, startLogMsg, createProgressCallback, finishLog, getActiveProjectDir, runBuildPushDeploy, buildDoctorReport, buildHistoryReport, writeProtectedDataFromSource, makePipelineReporter, allBoards, runModifyAll, autoGenerateInitial, updateStreamingMsg, appendLog],
  );

  const commandSuggestions = useMemo(() => {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed.startsWith('/')) return [];
    return chatCommandsForMode(modeAllowsDeploy(getAppMode()))
      .filter((item) => item.command.startsWith(trimmed))
      .slice(0, 5);
  }, [input]);

  // ─── Chat log viewport ──────────────────────────────────────────────────────
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const termWidth = stdout?.columns ?? 80;
  // Content width minus the outer frame (border 2 + paddingX 2) and the
  // scrollbar gutter (gap 1 + bar 1).
  const logWidth = Math.max(20, termWidth - 6);
  // Conditional chrome shrinks the log instead of overflowing the screen.
  const billerLine = describeBillerStatus(billerStatus);
  const reserved = CHROME_ROWS + (llmError ? 2 : 0) + commandSuggestions.length + (billerLine ? 1 : 0);
  const logHeight = Math.max(MIN_LOG_HEIGHT, termHeight - reserved);

  // Re-wrapping every message on every streamed token is the one hot path here,
  // so unchanged messages keep their wrapped lines across renders.
  const wrapCacheRef = useRef<WrapCache>(new Map());
  const lines = useMemo(
    () => flattenMessages(messages, logWidth, wrapCacheRef.current),
    [messages, logWidth],
  );

  // Clamp: history trimming (MAX_MESSAGES) and terminal resizes both shrink the
  // scrollable range under a parked offset.
  const effectiveOffset = clampOffset(scrollOffset, lines.length, logHeight);
  const hiddenNewer = effectiveOffset;
  const hiddenOlder = maxScrollOffset(lines.length, logHeight) - effectiveOffset;
  const rows = visibleLines(lines, logHeight, effectiveOffset);
  const scrollbar = scrollbarColumn(lines.length, logHeight, effectiveOffset);

  // useInput re-subscribes each render, but the handler still closes over the
  // metrics of the render that registered it — read them through a ref so a
  // burst of keypresses cannot page by a stale height.
  const viewRef = useRef({ totalLines: lines.length, logHeight });
  viewRef.current = { totalLines: lines.length, logHeight };

  // ESC: go back to welcome screen · PgUp/PgDn: scroll chat history by a page
  useInput((_input, key) => {
    if (key.escape) onNavigate?.('welcome');
    if (key.pageUp) {
      const view = viewRef.current;
      setScrollOffset((offset) =>
        clampOffset(offset + pageStep(view.logHeight), view.totalLines, view.logHeight),
      );
    }
    if (key.pageDown) {
      const view = viewRef.current;
      setScrollOffset((offset) =>
        clampOffset(offset - pageStep(view.logHeight), view.totalLines, view.logHeight),
      );
    }
  });

  return (
    // Outer frame wraps the whole screen — header, log and footer sit inside
    // it. paddingY stays 0 because the frame's own border rows replace the
    // blank padding rows the screen used to have (see CHROME_ROWS).
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={UI_COLORS.border}
      paddingX={1}
      paddingY={0}
    >
      {/* Header */}
      <Box
        borderStyle="round"
        borderColor={UI_COLORS.border}
        padding={1}
        marginBottom={1}
        width="100%"
        flexDirection="column"
        alignItems="center"
      >
        <Text bold color={UI_COLORS.logo}>{headerTitle}</Text>
        <Text color={UI_COLORS.subtitle}>{headerLLMInfo} · Mode: {appModeInfo(getAppMode()).label}</Text>
        {billerLine && <Text color={UI_COLORS.subtitle}>{billerLine}</Text>}
        <Text color={UI_COLORS.subtitle}>Chat to create or modify this dashboard</Text>
      </Box>

      {/* LLM config warning */}
      {llmError && (
        <Box marginBottom={1}>
          <Text color="yellow">Warning: {llmError}</Text>
        </Box>
      )}

      {/* Message log — fixed height to prevent layout shifts, scrollbar right */}
      <Box height={logHeight} overflow="hidden" marginBottom={0}>
        <Box flexDirection="column" width={logWidth} flexShrink={0}>
          {rows.map((line) => (
            <ChatLineRow key={line.key} line={line} />
          ))}
        </Box>
        <Box flexDirection="column" width={1} flexShrink={0} marginLeft={1}>
          {/* '░' track rather than '│' — a line here reads as a second frame. */}
          {scrollbar.map((filled, row) => (
            <Text key={row} color={filled ? UI_COLORS.logo : UI_COLORS.border} dimColor={!filled}>
              {filled ? '█' : '░'}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Scroll position indicator — always rendered so the layout never shifts */}
      <Text color={hiddenNewer > 0 ? 'yellow' : UI_COLORS.subtitle}>
        {hiddenNewer > 0
          ? `↑ ${hiddenOlder} older · ↓ ${hiddenNewer} newer (PgDn for latest)`
          : hiddenOlder > 0
            ? `↑ ${hiddenOlder} older (PgUp)`
            : ' '}
      </Text>

      {/* Loading indicator — phase-weighted progress bar when a pipeline is active */}
      {isLoading && (pipeline ? (
        <PipelineProgress
          phase={pipeline.phase}
          pct={pipeline.pct}
          phaseStartedAt={pipeline.phaseStartedAt}
          typicalMs={typicalDurations[pipeline.phase]}
          phases={opPhasesRef.current ?? undefined}
        />
      ) : (
        // Single liveness indicator: once the assistant bubble streams (or
        // shows its elapsed-time ticker), the rotating remark stands down.
        !messages.some((m) => m.isStreaming) && <LoadingRemark />
      ))}

      {commandSuggestions.length > 0 && (
        <Box flexDirection="column">
          {commandSuggestions.map((item) => (
            <Text key={item.command} color={UI_COLORS.subtitle}>
              <Text color={item.color}>{item.command}</Text>
              {'  '}
              <Text color={UI_COLORS.subtitle}>[{item.category}] </Text>
              {item.description}
            </Text>
          ))}
        </Box>
      )}

      {/* Input field */}
      <Box borderStyle="single" borderColor={UI_COLORS.border} padding={0}>
        <Text color={UI_COLORS.logo}>{'> '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type a message or /command..."
        />
      </Box>

      {/* Footer hint */}
      <HintBar keys={['scroll', 'commands', 'back']} />
    </Box>
  );
}

export default ChatScreen;
