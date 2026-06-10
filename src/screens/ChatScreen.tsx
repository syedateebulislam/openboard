/**
 * ChatScreen — Primary LLM interaction interface for OpenBoard.
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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ChatMessageComponent } from '../components/ChatMessage.js';
import { LoadingRemark } from '../components/LoadingRemark.js';
import { PipelineProgress } from '../components/PipelineProgress.js';
import { PipelineReporter, PHASE_ORDER } from '../services/project/pipelinePhases.js';
import type { PipelinePhase } from '../services/project/pipelinePhases.js';
import { RunStateService } from '../services/project/RunStateService.js';
import { parseCommand, HELP_TEXT, COMMANDS_TEXT, CHAT_COMMANDS, formatUnknownCommandMessage } from '../utils/commandParser.js';
import type { ChatMessage, BoardConfig } from '../types/board.js';
import type { LLMProvider, LLMMessage } from '../types/llm.js';
import { LLMService } from '../services/llm/LLMService.js';
import { ConfigService } from '../services/config/ConfigService.js';
import { ProjectManager } from '../services/project/ProjectManager.js';
import { TemplateService } from '../services/template/TemplateService.js';
import { DataParserService } from '../services/data/DataParserService.js';
import { DataAnalyzer } from '../services/data/DataAnalyzer.js';
import { SYSTEM_PROMPT } from '../services/llm/prompts/systemPrompt.js';
import { extractFiles } from '../utils/codeExtractor.js';
import type { Screen } from '../App.js';
import { BoardRegistryService } from '../services/project/BoardRegistryService.js';
import { PromptHistoryService } from '../services/project/PromptHistoryService.js';
import { UI_COLORS } from '../theme.js';
import { DASHBOARD_LOADING_REMARKS } from '../constants/loadingRemarks.js';

const projectManager = new ProjectManager();

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
 * Get a default model name for a provider when none is configured.
 */
function getDefaultModel(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'openai-codex':
      return 'gpt-5.5';
    case 'anthropic':
      return 'claude-sonnet-4-5';
    case 'ollama':
      return 'qwen2.5-coder:7b';
    case 'moonshot':
      return 'moonshot-v1-8k';
    default:
      return 'gpt-4o';
  }
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  board: BoardConfig;
  onNavigate?: (screen: Screen) => void;
  messages?: ChatMessage[];
  autoGenerateInitial?: boolean;
}

interface SendToLLMOptions {
  recordPrompt?: boolean;
  promptSource?: 'initial' | 'manual' | 'update';
  dataSummary?: string;
}

// ─── ChatScreen ───────────────────────────────────────────────────────────────

// Maximum messages to keep in history to prevent memory issues
const MAX_MESSAGES = 100;
// Maximum chat history messages to include in LLM context
const MAX_CONTEXT_MESSAGES = 20;

function lineCount(content: string): number {
  return Math.max(1, content.split('\n').length);
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
    onProgress('   Re-enter the Vercel token in Settings only if you want OpenBoard to run direct CLI deploys and set Vercel env vars.');
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

function pickStaticRemark(): string {
  const index = Math.floor(Math.random() * DASHBOARD_LOADING_REMARKS.length);
  return DASHBOARD_LOADING_REMARKS[index];
}

export function ChatScreen({
  board,
  onNavigate,
  messages: initialMessages = [],
  autoGenerateInitial = false,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    newMsg(
      'system',
      'Type a message to generate components or use slash commands (/help for list)',
    ),
    ...initialMessages,
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pipeline, setPipeline] = useState<{ phase: PipelinePhase; pct: number; phaseStartedAt: number } | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<'deploy' | 'push' | null>(null);
  const [llmProvider, setLlmProvider] = useState<LLMProvider | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const streamingMsgRef = useRef<string | null>(null);
  const logMsgRef = useRef<string | null>(null);
  const lastOperationLogRef = useRef<string>('');
  const autoGenTriggered = useRef(false);
  const headerTitle = autoGenerateInitial ? 'New Dashboard' : board.title;
  const headerProvider = llmProvider?.name ?? 'LLM not configured';
  const headerRemark = useMemo(() => pickStaticRemark(), []);

  // ── Initialize LLM provider from config ──────────────────────────────────
  useEffect(() => {
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
        provider: provider as 'openai' | 'openai-codex' | 'anthropic' | 'ollama' | 'moonshot',
        model: model || getDefaultModel(provider),
        apiKey,
        baseUrl,
        ollamaHost,
      };

      const createdProvider = LLMService.createProvider(llmConfig);
      setLlmProvider(createdProvider);
    } catch (err: any) {
      setLlmError(`Failed to initialize LLM: ${err.message}`);
    }
  }, []);

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
  const makePipelineReporter = useCallback((onProgress: (line: string) => void): PipelineReporter => {
    return new PipelineReporter(onProgress, (event) => {
      if (event.event === 'result' || event.phase === 'done') {
        setPipeline(null);
        return;
      }
      if (event.event === 'phase' && event.phase) {
        setPipeline({ phase: event.phase, pct: event.pct ?? 0, phaseStartedAt: Date.now() });
      } else if (event.event === 'log' && event.phase && event.pct !== undefined) {
        setPipeline((prev) => (prev && prev.phase === event.phase ? { ...prev, pct: event.pct! } : prev));
      }
    });
  }, []);

  const getActiveProjectDir = useCallback((): string => {
    if (board.outputDir) return board.outputDir;
    const sharedDir = new BoardRegistryService().getSharedProjectDir();
    return sharedDir ?? '';
  }, [board.outputDir]);

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
    const checks = [
      ['LLM provider', Boolean(config.get('llm.provider'))],
      ['GitHub config', config.has('github.token') || config.has('github.username')],
      ['Vercel config/login path', config.has('vercel.token') || Boolean(info?.hasVercel)],
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
      'OpenBoard Doctor',
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
    async (projectDir: string, label: string): Promise<void> => {
      setIsLoading(true);
      const logId = startLogMsg(label);
      const reporter = makePipelineReporter(createProgressCallback(logId));
      const onProgress = reporter.progress;

      try {
        reporter.phase('build');
        onProgress('Running pre-deploy checks...');
        const preDeploy = projectManager.preDeployChecks(projectDir, onProgress);
        if (!preDeploy.success) {
          onProgress(`Pre-deploy checks failed: ${preDeploy.error}`);
          return;
        }

        const info = projectManager.getProjectInfo(projectDir);
        if (info && !info.hasNodeModules) {
          onProgress('Installing dependencies...');
          const installResult = await projectManager.install(projectDir, onProgress);
          if (!installResult.success) {
            onProgress(`Install failed: ${installResult.error}`);
            return;
          }
        }

        onProgress('Building project...');
        const buildResult = await projectManager.build(projectDir, onProgress);
        if (!buildResult.success) {
          onProgress(`Build failed: ${buildResult.error}`);
          return;
        }
        onProgress('Build successful');

        reporter.phase('push');
        onProgress('Pushing to GitHub...');
        const pushResult = await projectManager.commitAndPush(
          projectDir,
          `Update: ${new Date().toISOString()}`,
          onProgress,
        );

        if (!pushResult.success) {
          onProgress(`GitHub push skipped/failed: ${pushResult.error || 'Unknown error'}`);
          onProgress('Continuing with Vercel deployment...');
        } else {
          const repoInfo = pushResult.repoUrl ? ` -> ${pushResult.repoUrl}` : '';
          onProgress(`Pushed to GitHub (${pushResult.commitHash?.slice(0, 7)})${repoInfo}`);
        }

        reporter.phase('deploy');
        onProgress('Deploying to Vercel...');
        const deployResult = await projectManager.deploy(projectDir, onProgress);
        reportDeployResult(deployResult, pushResult.success && pushResult.pushed === true, onProgress);
        reporter.phase('done');
      } catch (error: any) {
        onProgress(`Pipeline error: ${error.message}`);
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
- Add or update it as its own dashboard tab in App.tsx.
- Preserve the centered OpenBoard master header exactly: <h1 className="app-title">OpenBoard</h1>.
- Preserve existing dashboard tabs, imports, auth wrapper, LoginPage, AuthProvider, user display, and logout behavior.
- Do not rename the app/header to "${board.title}". Use "${board.title}" only as a tab label and content heading.
- Prefer dashboard-specific component names and files so additions do not overwrite other dashboards.`;
        }

        const activeProjectDir = getActiveProjectDir();
        if (activeProjectDir) {
          const appPath = join(activeProjectDir, 'src', 'App.tsx');
          if (existsSync(appPath)) {
            const currentApp = readFileSync(appPath, 'utf-8').slice(0, 12000);
            boardContext += `\n\nCURRENT App.tsx (preserve existing tabs and extend this):\n${currentApp}`;
          }
        }
      } catch {
        // Registry/current app context is helpful but not required for generation.
      }

      contextMessages.push({
        role: 'system',
        content: SYSTEM_PROMPT + boardContext,
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

      const files = extractFiles(content);
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

      try {
        let fullContent = '';

        // Stream the response from the LLM
        for await (const chunk of llmProvider.stream({
          messages: contextMessages,
          temperature: 0.7,
          maxTokens: 4096,
        })) {
          fullContent += chunk.text;
          updateStreamingMsg(streamMsg.id, fullContent, chunk.done);

          if (chunk.done) break;
        }

        // If streaming produced no content, fall back to complete()
        if (!fullContent.trim()) {
          fullContent = await llmProvider.complete({
            messages: contextMessages,
            temperature: 0.7,
            maxTokens: 4096,
          });
          updateStreamingMsg(streamMsg.id, fullContent, true);
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
        }
        return writtenFiles;
      } catch (err: any) {
        const errorMessage = err.message || 'Unknown LLM error';
        updateStreamingMsg(streamMsg.id, `Error: ${errorMessage}`, true);
        addMsg(newMsg('error', `LLM error: ${errorMessage}`));
        return [];
      } finally {
        streamingMsgRef.current = null;
        setIsLoading(false);
      }
    },
    [llmProvider, llmError, addMsg, updateStreamingMsg, buildLLMContext, writeExtractedFiles, board, getActiveProjectDir],
  );

  // ── Auto-generate initial dashboard when entering chat with data ──────────
  useEffect(() => {
    if (!autoGenerateInitial) return;
    if (autoGenTriggered.current) return;
    if (!llmProvider || !board.dataSummary || !getActiveProjectDir()) return;

    autoGenTriggered.current = true;
    const autoPrompt = `Generate an initial dashboard tab for "${board.title}" (${board.type} type) inside the existing OpenBoard master React app. Based on my data analysis, create appropriate metric cards, charts, and visualizations. Load real rows with useProtectedDashboardData('${board.name}') from src/hooks/useProtectedDashboardData.ts. Do not embed raw source rows or sensitive data in frontend code. Use the column names and data types from the analysis to pick the best chart types. Include at least 2-3 charts and some metric/stat cards. Preserve any existing dashboard tabs in App.tsx and add this dashboard as a separate tab. Keep the centered master header text exactly "OpenBoard"; do not replace it with "${board.title}".`;

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
      if (!text.trim() || isLoading) return;
      setInput('');

      const userMsg = newMsg('user', text);
      addMsg(userMsg);

      // Handle pending confirmation for destructive actions
      if (pendingConfirm) {
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
            const logId = startLogMsg('Confirmed. Starting full deploy pipeline...');
            const reporter = makePipelineReporter(createProgressCallback(logId));
            const onProgress = reporter.progress;

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

              // Step 1: Build the project
              onProgress('Building project...');
              const buildResult = await projectManager.build(projectDir, onProgress);

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
              const deployResult = await projectManager.deploy(projectDir, onProgress);
              reportDeployResult(deployResult, pushResult.success && pushResult.pushed === true, onProgress);

              reporter.phase('done');
              setPipeline(null);
              finishLog(logId);
              setIsLoading(false);
            } catch (error: any) {
              onProgress(`Deploy pipeline error: ${error.message}`);
              setPipeline(null);
              finishLog(logId);
              setIsLoading(false);
            }
          } else if (pendingConfirm === 'push') {
            setIsLoading(true);
            const logId = startLogMsg('Confirmed. Committing and pushing to GitHub...');
            const onProgress = createProgressCallback(logId);

            try {
              const result = await projectManager.commitAndPush(
                projectDir,
                `Update: ${new Date().toISOString()}`,
                onProgress,
              );

              if (!result.success) {
                onProgress(`Push failed: ${result.error}`);
              } else {
                const repoInfo = result.repoUrl ? ` -> ${result.repoUrl}` : '';
                onProgress(`Pushed to GitHub (commit: ${result.commitHash?.slice(0, 7)})${repoInfo}`);
              }

              finishLog(logId);
              setIsLoading(false);
            } catch (error: any) {
              onProgress(`Error: ${error.message}`);
              finishLog(logId);
              setIsLoading(false);
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
        addMsg(newMsg('system', `Command palette\n${COMMANDS_TEXT}`));
        return;
      }

      // ── /help ──────────────────────────────────────────────────────────────
      if (cmd.type === 'help') {
        addMsg(newMsg('system', HELP_TEXT));
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

      // ── build ──────────────────────────────────────────────────────────────
      if (cmd.type === 'build') {
        const projectDir = getActiveProjectDir();
        if (!projectDir) {
          addMsg(newMsg('error', 'No project directory. Create a board first.'));
          return;
        }
        setIsLoading(true);
        const logId = startLogMsg(`Building project in ${projectDir}...`);
        const reporter = makePipelineReporter(createProgressCallback(logId));
        const onProgress = reporter.progress;

        try {
          reporter.phase('build');
          // Auto-install if node_modules missing
          const info = projectManager.getProjectInfo(projectDir);
          if (info && !info.hasNodeModules) {
            onProgress('Installing dependencies...');
            const installResult = await projectManager.install(projectDir, onProgress);
            if (!installResult.success) {
              onProgress(`Install failed: ${installResult.error}`);
              setPipeline(null);
              finishLog(logId);
              setIsLoading(false);
              return;
            }
          }

          const result = await projectManager.build(projectDir, onProgress);
          if (!result.success) {
            onProgress(`Build failed: ${result.error}`);
          } else {
            onProgress(`Build complete. Output: ${result.outputDir}`);
          }

          setPipeline(null);
          finishLog(logId);
          setIsLoading(false);
        } catch (error: any) {
          onProgress(`Build error: ${error.message}`);
          setPipeline(null);
          finishLog(logId);
          setIsLoading(false);
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
          addMsg(newMsg('error', 'No prompt history found for this dashboard. Make a manual LLM change first so OpenBoard knows what to recreate on update.'));
          return;
        }

        setIsLoading(true);
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

This is an OpenBoard update run. The CSV/JSON file may have changed, but the dashboard intent should remain the same as the saved prompt history.

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
3. Preserve other dashboard tabs in the shared OpenBoard app.
4. Keep the centered master header text exactly "OpenBoard"; do not replace it with "${board.title}".
5. Load real dashboard rows with useProtectedDashboardData('${board.name}') from src/hooks/useProtectedDashboardData.ts.
6. Do NOT embed raw source rows or sensitive data in App.tsx, component files, or src/data files.
7. Return all changed files using the required //CODE_START format.`;

          finishLog(logId);
          reporter.phase('generate');
          const writtenFiles = await sendToLLM(updatePrompt, {
            recordPrompt: false,
            promptSource: 'update',
            dataSummary: latestSummary,
          });
          setPipeline(null);

          if (writtenFiles.length === 0) {
            addMsg(newMsg('error', 'Update did not write any files. Build/push/deploy skipped.'));
            setIsLoading(false);
            return;
          }

          await runBuildPushDeploy(projectDir, `Building, pushing, and deploying "${board.title}" after data update...`);
        } catch (error: any) {
          onProgress(`Update failed: ${error.message}`);
          setPipeline(null);
          finishLog(logId);
          setIsLoading(false);
        }
        return;
      }

      // ── deploy ─────────────────────────────────────────────────────────────
      if (cmd.type === 'deploy') {
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
          // Stop existing preview if running
          if (isRestart) {
            onProgress('Stopping current preview server...');
            projectManager.stopPreview(projectDir);
          }

          // Auto-install if node_modules missing
          const info = projectManager.getProjectInfo(projectDir);
          if (info && !info.hasNodeModules) {
            onProgress('Installing dependencies...');
            const installResult = await projectManager.install(projectDir, onProgress);
            if (!installResult.success) {
              onProgress(`Install failed: ${installResult.error}`);
              finishLog(logId);
              setIsLoading(false);
              return;
            }
          }

          // Rebuild before restarting to pick up latest code changes
          if (isRestart) {
            onProgress('Rebuilding with latest changes...');
            const buildResult = await projectManager.build(projectDir, onProgress);
            if (!buildResult.success) {
              onProgress(`Build failed: ${buildResult.error}`);
              finishLog(logId);
              setIsLoading(false);
              return;
            }
            onProgress('Build successful');
          }

          const result = await projectManager.preview(projectDir, undefined, onProgress);
          if (result.success) {
            onProgress(`Preview running at ${result.url || 'http://localhost:5173'}`);
          } else {
            onProgress(`Preview failed: ${result.error}`);
          }
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
        await sendToLLM(text);
      }
    },
    [isLoading, board, onNavigate, addMsg, pendingConfirm, llmProvider, llmError, sendToLLM, startLogMsg, createProgressCallback, finishLog, getActiveProjectDir, runBuildPushDeploy, buildDoctorReport, buildHistoryReport, writeProtectedDataFromSource, makePipelineReporter],
  );

  // ESC: go back to welcome screen
  useInput((_input, key) => {
    if (key.escape) onNavigate?.('welcome');
  });

  // Get terminal height for fixed message area
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  // Reserve rows for: header(5) + warning(2) + input(2) + footer(1) + loader(1) + padding(2)
  const availableMessageHeight = Math.max(6, termHeight - 13);
  const messageAreaHeight = Math.max(6, Math.ceil(availableMessageHeight / 2));

  const commandSuggestions = useMemo(() => {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed.startsWith('/')) return [];
    return CHAT_COMMANDS
      .filter((item) => item.command.startsWith(trimmed))
      .slice(0, 5);
  }, [input]);

  const visibleMessages = useMemo(() => {
    const recent = messages.slice(-4);
    const selected: Array<{ message: ChatMessage; maxLines: number }> = recent.map((message) => ({
      message,
      maxLines: 1,
    }));
    let remaining = Math.max(0, messageAreaHeight - selected.length);

    for (let i = selected.length - 1; i >= 0 && remaining > 0; i--) {
      const item = selected[i];
      const message = item.message;
      const desiredLines = Math.min(lineCount(message.content), 20);
      const extraLines = Math.min(desiredLines - item.maxLines, remaining);
      item.maxLines += Math.max(0, extraLines);
      remaining -= Math.max(0, extraLines);
    }

    return selected;
  }, [messages, messageAreaHeight]);

  return (
    <Box flexDirection="column" padding={1}>
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
        <Text bold color={UI_COLORS.logo}>{headerTitle} <Text color={UI_COLORS.subtitle}>({headerProvider})</Text></Text>
        <Text color={UI_COLORS.subtitle}>Internal LLM chat for dashboard creation</Text>
        <Text color={UI_COLORS.subtitle}>{headerRemark}</Text>
      </Box>

      {/* LLM config warning */}
      {llmError && (
        <Box marginBottom={1}>
          <Text color="yellow">Warning: {llmError}</Text>
        </Box>
      )}

      {/* Message log — fixed height to prevent layout shifts */}
      <Box flexDirection="column" height={messageAreaHeight} overflow="hidden" marginBottom={0}>
        {visibleMessages.map(({ message, maxLines }) => (
          <ChatMessageComponent key={message.id} message={message} maxLines={maxLines} />
        ))}
      </Box>

      {/* Loading indicator — phase-weighted progress bar when a pipeline is active */}
      {isLoading && (pipeline ? (
        <PipelineProgress
          phase={pipeline.phase}
          pct={pipeline.pct}
          phaseStartedAt={pipeline.phaseStartedAt}
          typicalMs={typicalDurations[pipeline.phase]}
        />
      ) : (
        <LoadingRemark />
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
      <Text color={UI_COLORS.subtitle}>ESC to go back | /help for commands</Text>
    </Box>
  );
}

export default ChatScreen;
