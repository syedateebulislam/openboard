import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBoardConfig, getPreset } from '../../config/boardPresets.js';
import { resolveInitialIntent } from '../../config/dashboardPrompts.js';
import { ConfigService } from '../config/ConfigService.js';
import { DataAnalyzer } from '../data/DataAnalyzer.js';
import { DataParserService } from '../data/DataParserService.js';
import { LLMService } from '../llm/LLMService.js';
import { SYSTEM_PROMPT } from '../llm/prompts/systemPrompt.js';
import { TemplateService } from '../template/TemplateService.js';
import { BuildService } from '../build/BuildService.js';
import { DeployVerificationService } from '../deploy/DeployVerificationService.js';
import { extractFiles } from '../../utils/codeExtractor.js';
import { classifyAgentError } from '../../utils/errorCodes.js';
import type { BoardConfig } from '../../types/board.js';
import type { LLMConfig } from '../../types/llm.js';
import { BoardRegistryService } from './BoardRegistryService.js';
import { PromptHistoryService } from './PromptHistoryService.js';
import { ProjectLockService } from './ProjectLockService.js';
import { ProjectManager } from './ProjectManager.js';
import { PipelineReporter } from './pipelinePhases.js';
import type { PipelineEventSink } from './pipelinePhases.js';
import { RunStateService } from './RunStateService.js';
import type { RunRecord, RunTokenUsage } from './RunStateService.js';

export type UpdateProgress = (line: string) => void;

export interface DashboardPlan {
  title: string;
  selector: string;
  type: BoardConfig['type'];
  rowCount: number;
  columnCount: number;
  dataSummary: string;
}

export interface DashboardUpdateResult {
  success: boolean;
  error?: string;
  /** Stable machine-readable failure class (see utils/errorCodes.ts). */
  errorCode?: string;
  board?: BoardConfig;
  writtenFiles?: string[];
  deployUrl?: string;
  /** deploy-N git tag created for this deploy (rollback target). */
  deployTag?: string;
  /** Post-deploy verification outcome; undefined when no URL to verify. */
  verified?: boolean;
  /** Persistent run id — resumable with `openboard agent resume <id>`. */
  runId?: string;
  /** True when this result was returned from a prior run (idempotency/resume). */
  reused?: boolean;
  /** Set on --dry-run: what would be generated, without calling the LLM. */
  plan?: DashboardPlan;
  tokenUsage?: RunTokenUsage;
}

export interface CreateDashboardOptions {
  dataFile: string;
  title?: string;
  type?: BoardConfig['type'];
  prompt?: string;
  /** Return the prior result when a succeeded run already used this key. */
  idempotencyKey?: string;
  /** Parse + analyze and return the plan without LLM/deploy. */
  dryRun?: boolean;
}

export interface PromptUpdateOptions {
  dashboard: string;
  prompt: string;
  dataFile?: string;
  dryRun?: boolean;
}

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
    case 'gemini':
      return 'gemini-2.5-pro';
    default:
      return 'gpt-4o';
  }
}

function createLLMConfig(config: ConfigService): LLMConfig {
  const provider = config.get('llm.provider') as LLMConfig['provider'] | undefined;
  if (!provider) {
    throw new Error('No LLM provider configured. Configure LLM settings first.');
  }

  let apiKey: string | undefined;
  try {
    apiKey = config.getDecrypted('llm.apiKey');
  } catch {
    const rawApiKey = config.get('llm.apiKey');
    apiKey = typeof rawApiKey === 'string' && !rawApiKey.startsWith('enc:')
      ? rawApiKey
      : undefined;
  }

  return {
    provider,
    model: (config.get('llm.model') as string | undefined) || getDefaultModel(provider),
    apiKey,
    baseUrl: config.get('llm.baseUrl') as string | undefined,
    ollamaHost: config.get('llm.ollamaHost') as string | undefined,
  };
}

function matchesBoard(board: BoardConfig, selector: string): boolean {
  const normalized = selector.trim().toLowerCase();
  return [board.id, board.name, board.title]
    .some((value) => value.toLowerCase() === normalized);
}

function isVercelAuthError(error: string | undefined): boolean {
  if (!error) return false;
  return /Vercel is not authenticated|No existing credentials|specified token is not valid|vercel login/i.test(error);
}

function titleFromDataFile(dataFile: string): string {
  const fileName = basename(dataFile, extname(dataFile)).replace(/[-_]+/g, ' ').trim();
  return fileName
    ? fileName.replace(/\b\w/g, (char) => char.toUpperCase())
    : `Dashboard ${new Date().toISOString().slice(0, 10)}`;
}

function buildHistoryText(entries: ReturnType<PromptHistoryService['read']>): string {
  return entries
    .map((entry, index) => `${index + 1}. [${entry.source}] ${entry.prompt}`)
    .join('\n\n');
}

/** chars/4 token estimate for providers that don't report usage. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Ask the configured LLM to remove one dashboard's tab/import/content from the
 * shared app's src/App.tsx while preserving the auth shell and every remaining
 * dashboard. Lives in this non-React module so the headless agent path and the
 * Ink TUI can both call it without pulling Ink into automation contexts.
 */
export async function removeDashboardFromGeneratedApp(
  removedBoard: BoardConfig,
  remainingBoards: BoardConfig[],
  projectDir: string,
): Promise<string> {
  const appPath = join(projectDir, 'src', 'App.tsx');
  if (!existsSync(appPath)) {
    return 'Skipped UI cleanup because src/App.tsx was not found.';
  }

  const config = new ConfigService();
  const provider = config.get('llm.provider') as string | undefined;
  if (!provider) {
    throw new Error('No LLM provider is configured, so generated UI cleanup cannot run.');
  }

  let apiKey: string | undefined;
  try {
    apiKey = config.getDecrypted('llm.apiKey');
  } catch {
    apiKey = config.get('llm.apiKey') as string | undefined;
  }

  const llmConfig: LLMConfig = {
    provider: provider as LLMConfig['provider'],
    model: (config.get('llm.model') as string | undefined) || getDefaultModel(provider),
    apiKey,
    baseUrl: config.get('llm.baseUrl') as string | undefined,
    ollamaHost: config.get('llm.ollamaHost') as string | undefined,
  };

  const llm = LLMService.createProvider(llmConfig);
  const currentApp = readFileSync(appPath, 'utf-8');
  const prompt = `${SYSTEM_PROMPT}

Task: remove one dashboard from the existing shared OpenBoard app.

Dashboard to remove:
- Title: ${removedBoard.title}
- Slug/name: ${removedBoard.name}
- Type: ${removedBoard.type}

Dashboards that must remain:
${remainingBoards.length > 0
  ? remainingBoards.map((board) => `- ${board.title} (${board.name}, ${board.type})`).join('\n')
  : '- None. Keep the authenticated app shell and show an empty/welcome state.'}

Current src/App.tsx:
${currentApp}

Requirements:
1. Return ONLY an updated App.tsx file block using the required //CODE_START format.
2. Remove the tab, route/branch, imports, labels, and visible content for "${removedBoard.title}".
3. Preserve AuthProvider, LoginPage, useAuth, the header user greeting (render the signed-in user as "Hi, <username>" via <span className="app-greeting">), and logout behavior.
4. Preserve every remaining dashboard and its imports.
5. Preserve the centered OpenBoard master header exactly: <h1 className="app-title">OpenBoard</h1>.
6. Do not modify unrelated styling or auth behavior.`;

  const response = await llm.complete({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    maxTokens: 4096,
  });

  const files = extractFiles(response).filter((file) => file.path === 'App.tsx');
  if (files.length === 0) {
    throw new Error('The LLM did not return an App.tsx update.');
  }

  const templateService = new TemplateService();
  await templateService.writeGeneratedFile(projectDir, 'App.tsx', files[0].content);
  return 'src/App.tsx was cleaned up.';
}

export class DashboardUpdateService {
  private registry: BoardRegistryService;
  private history: PromptHistoryService;
  private projectManager: ProjectManager;
  private templateService: TemplateService;
  private events?: PipelineEventSink;
  private runs: RunStateService;

  constructor(
    registry = new BoardRegistryService(),
    history = new PromptHistoryService(),
    projectManager = new ProjectManager(),
    templateService = new TemplateService(),
    events?: PipelineEventSink,
    runs = new RunStateService(),
  ) {
    this.registry = registry;
    this.history = history;
    this.projectManager = projectManager;
    this.templateService = templateService;
    this.events = events;
    this.runs = runs;
  }

  listBoards(): BoardConfig[] {
    return this.registry.listBoards();
  }

  findBoard(selector: string): BoardConfig | undefined {
    return this.listBoards().find((board) => matchesBoard(board, selector));
  }

  listRuns(limit = 20): RunRecord[] {
    return this.runs.list(limit);
  }

  runSummary(): ReturnType<RunStateService['summarize']> {
    return this.runs.summarize();
  }

  async createFromDataSource(
    options: CreateDashboardOptions,
    onProgress?: UpdateProgress,
  ): Promise<DashboardUpdateResult> {
    // Idempotency: a retried create with the same key returns the prior result
    // instead of generating a duplicate dashboard.
    if (options.idempotencyKey && !options.dryRun) {
      const prior = this.runs.findByIdempotencyKey(options.idempotencyKey);
      if (prior) {
        this.note(onProgress, `Idempotency key matched succeeded run ${prior.runId}; returning prior result.`);
        return this.resultFromRun(prior);
      }
    }

    const run = options.dryRun
      ? undefined
      : this.runs.createRun('create', { ...options }, options.idempotencyKey);
    const reporter = this.makeReporter(onProgress, run);
    let lock: ReturnType<typeof ProjectLockService.acquire> | undefined;

    try {
      const dataFile = resolve(options.dataFile);
      const title = options.title?.trim() || titleFromDataFile(dataFile);
      const typeProvided = options.type !== undefined;
      const type = options.type ?? 'custom';
      getPreset(type);

      reporter.phase('parse');
      reporter.log(`Reading data source: ${dataFile}`);
      const parsed = await DataParserService.parse(dataFile);

      reporter.phase('analyze');
      const analysis = DataAnalyzer.analyze(parsed);
      const dataSummary = DataAnalyzer.generateSummary(analysis);
      reporter.log(`Parsed data source (${analysis.rowCount} rows, ${analysis.columnCount} columns; summary samples ${Math.min(3, analysis.rowCount)} rows)`);

      const boardName = createBoardConfig(title);

      if (options.dryRun) {
        reporter.log('Dry run: stopping before generation. No LLM call, no files written.');
        return {
          success: true,
          plan: {
            title: boardName.title,
            selector: boardName.name,
            type,
            rowCount: analysis.rowCount,
            columnCount: analysis.columnCount,
            dataSummary,
          },
        };
      }

      const board: BoardConfig = {
        id: `board-${randomUUID()}`,
        name: boardName.name,
        title: boardName.title,
        type,
        outputDir: '',
        dataFiles: [dataFile],
        components: [],
        createdAt: new Date().toISOString(),
        dataSummary,
      };

      reporter.log(`Preparing OpenBoard workspace for "${board.title}"...`);
      const scaffold = await this.projectManager.scaffold(board);
      if (!scaffold.success || !scaffold.projectDir) {
        return this.failure(run, { board }, `Scaffold failed: ${scaffold.error}`);
      }

      const initializedBoard: BoardConfig = {
        ...scaffold.board,
        outputDir: scaffold.projectDir,
        dataSummary,
      };
      if (run) {
        run.boardId = initializedBoard.id;
        run.boardName = initializedBoard.name;
        run.boardTitle = initializedBoard.title;
        run.projectDir = scaffold.projectDir;
        this.runs.save(run);
      }

      lock = ProjectLockService.acquire(scaffold.projectDir);
      if (!lock.success) {
        return this.failure(run, { board: initializedBoard }, lock.error ?? 'Project lock failed');
      }

      await this.writeProtectedData(initializedBoard, parsed, dataSummary, reporter.progress);

      const writtenFiles = await this.generateAndWriteFiles(
        initializedBoard,
        this.buildInitialPrompt(initializedBoard, dataSummary, options.prompt, typeProvided),
        reporter,
        run,
      );
      if (writtenFiles.length === 0) {
        return this.failure(run, { board: initializedBoard }, 'LLM did not return any writable files.');
      }
      if (run) {
        run.writtenFiles = writtenFiles;
        this.runs.save(run);
      }

      const updatedBoard: BoardConfig = {
        ...initializedBoard,
        components: [...new Set([...initializedBoard.components, ...writtenFiles])],
        generatedAt: new Date().toISOString(),
      };
      this.registry.upsertBoard(updatedBoard);
      this.history.append({
        boardId: updatedBoard.id,
        boardName: updatedBoard.name,
        boardTitle: updatedBoard.title,
        source: 'initial',
        prompt: options.prompt || 'Agent initial dashboard generation from data source.',
        writtenFiles,
        dataSummary,
      });

      return await this.buildPushDeploy(
        updatedBoard,
        writtenFiles,
        `Create ${updatedBoard.name}: ${new Date().toISOString()}`,
        reporter,
        run,
      );
    } catch (error: any) {
      return this.failure(run, {}, error.message);
    } finally {
      lock?.release();
    }
  }

  async updateByPrompt(
    options: PromptUpdateOptions,
    onProgress?: UpdateProgress,
  ): Promise<DashboardUpdateResult> {
    const board = this.findBoard(options.dashboard);
    if (!board) {
      return {
        success: false,
        error: `Dashboard not found: ${options.dashboard}`,
        errorCode: 'E_DASHBOARD_NOT_FOUND',
      };
    }
    return this.updateBoardWithPrompt(board, options.prompt, options.dataFile, onProgress, options.dryRun);
  }

  async updateBySelector(selector: string, onProgress?: UpdateProgress): Promise<DashboardUpdateResult> {
    const board = this.findBoard(selector);
    if (!board) {
      return {
        success: false,
        error: `Dashboard not found: ${selector}`,
        errorCode: 'E_DASHBOARD_NOT_FOUND',
      };
    }
    return this.updateBoard(board, onProgress);
  }

  async updateAll(onProgress?: UpdateProgress): Promise<DashboardUpdateResult[]> {
    const results: DashboardUpdateResult[] = [];
    for (const board of this.listBoards()) {
      onProgress?.(`\n=== Updating ${board.title} ===`);
      results.push(await this.updateBoard(board, onProgress));
    }
    return results;
  }

  async updateBoard(board: BoardConfig, onProgress?: UpdateProgress): Promise<DashboardUpdateResult> {
    const run = this.runs.createRun('refresh', { dashboard: board.name });
    const reporter = this.makeReporter(onProgress, run);
    let lock: ReturnType<typeof ProjectLockService.acquire> | undefined;

    try {
      const projectDir = board.outputDir || this.registry.getSharedProjectDir();
      if (!projectDir) {
        return this.failure(run, { board }, 'No generated app workspace found.');
      }

      const dataFile = board.dataFiles[0];
      if (!dataFile) {
        return this.failure(run, { board }, 'No data source is linked to this dashboard.');
      }

      const promptHistory = this.history.read(board.id);
      if (promptHistory.length === 0) {
        return this.failure(
          run,
          { board },
          'No prompt history found. Generate or modify this dashboard once before running update.',
        );
      }

      if (run) {
        run.boardId = board.id;
        run.boardName = board.name;
        run.boardTitle = board.title;
        run.projectDir = projectDir;
        this.runs.save(run);
      }

      reporter.phase('parse');
      reporter.log(`Reading latest data: ${dataFile}`);
      const parsed = await DataParserService.parse(dataFile);

      reporter.phase('analyze');
      const analysis = DataAnalyzer.analyze(parsed);
      const latestSummary = DataAnalyzer.generateSummary(analysis);
      reporter.log(`Parsed latest data (${analysis.rowCount} rows, ${analysis.columnCount} columns)`);

      lock = ProjectLockService.acquire(projectDir);
      if (!lock.success) {
        return this.failure(run, { board }, lock.error ?? 'Project lock failed');
      }

      await this.writeProtectedData(board, parsed, latestSummary, reporter.progress);

      const currentAppPath = join(projectDir, 'src', 'App.tsx');
      const currentApp = existsSync(currentAppPath)
        ? readFileSync(currentAppPath, 'utf-8').slice(0, 12000)
        : '';

      const boards = this.registry.listBoards();
      const historyText = promptHistory
        .map((entry, index) => `${index + 1}. [${entry.source}] ${entry.prompt}`)
        .join('\n\n');

      const prompt = `Regenerate/update the "${board.title}" dashboard tab using the latest data source.

This is a non-interactive OpenBoard update run. The CSV/JSON file may have changed, but the dashboard intent must remain the same as the saved prompt history.

Dashboard:
- Title: ${board.title}
- Name: ${board.name}
- Type: ${board.type}
- Data file: ${dataFile}

Registered dashboards in the shared app:
${boards.map((b) => `- ${b.title} (${b.name}, ${b.type})`).join('\n')}

Latest data analysis:
${latestSummary}

Saved prompt history to preserve:
${historyText}

Current src/App.tsx:
${currentApp}

Requirements:
1. Preserve the same dashboard tab and user-requested insights represented by the prompt history.
2. Update metrics, charts, tables, and data processing to reflect the latest data analysis.
3. Preserve other dashboard tabs in the shared OpenBoard app.
4. Preserve AuthProvider, LoginPage, useAuth, the header user greeting (render the signed-in user as "Hi, <username>" via <span className="app-greeting">), and logout behavior.
5. Keep the centered master header text exactly "OpenBoard"; do not replace it with "${board.title}".
6. Return all changed files using the required //CODE_START format.`;

      const writtenFiles = await this.generateAndWriteFiles(board, prompt, reporter, run);
      if (writtenFiles.length === 0) {
        return this.failure(run, { board }, 'LLM did not return any writable files.');
      }
      if (run) {
        run.writtenFiles = writtenFiles;
        this.runs.save(run);
      }

      const updatedBoard: BoardConfig = {
        ...board,
        outputDir: projectDir,
        dataSummary: latestSummary,
        components: [...new Set([...board.components, ...writtenFiles])],
        generatedAt: new Date().toISOString(),
      };
      this.registry.upsertBoard(updatedBoard);
      this.history.append({
        boardId: board.id,
        boardName: board.name,
        boardTitle: board.title,
        source: 'update',
        prompt: 'Non-interactive update from latest data using saved prompt history.',
        writtenFiles,
        dataSummary: latestSummary,
      });

      return await this.buildPushDeploy(
        updatedBoard,
        writtenFiles,
        `Update ${board.name}: ${new Date().toISOString()}`,
        reporter,
        run,
      );
    } catch (error: any) {
      return this.failure(run, { board }, error.message);
    } finally {
      lock?.release();
    }
  }

  /**
   * Remove a dashboard everywhere, so the deployed app matches the registry.
   *
   * Steps:
   *  1. LLM cleanup of src/App.tsx (drop tab/import/content).
   *  2. Delete orphaned component files unique to this dashboard.
   *  3. Delete the dashboard's protected data (json + aggregate + module).
   *  4. Remove from the registry + prompt history.
   *  5. Build, push, and deploy so the live UI reflects the removal.
   *
   * Registry removal only happens after code cleanup succeeds, so a failed
   * cleanup leaves the dashboard intact rather than orphaning the live app.
   */
  async removeDashboard(board: BoardConfig, onProgress?: UpdateProgress): Promise<DashboardUpdateResult> {
    const run = this.runs.createRun('remove', { dashboard: board.name });
    const reporter = this.makeReporter(onProgress, run);
    let lock: ReturnType<typeof ProjectLockService.acquire> | undefined;

    try {
      const projectDir = board.outputDir || this.registry.getSharedProjectDir();

      // No generated workspace — registry-only removal.
      if (!projectDir) {
        this.registry.removeBoard(board.id);
        reporter.log('Removed from registry. No generated app workspace was found for UI cleanup.');
        this.runs.complete(run, { boardId: board.id, boardName: board.name, boardTitle: board.title });
        return { success: true, board, runId: run.runId };
      }

      if (run) {
        run.boardId = board.id;
        run.boardName = board.name;
        run.boardTitle = board.title;
        run.projectDir = projectDir;
        this.runs.save(run);
      }

      lock = ProjectLockService.acquire(projectDir);
      if (!lock.success) {
        return this.failure(run, { board }, lock.error ?? 'Project lock failed');
      }

      const remainingBoards = this.registry.listBoards().filter((b) => b.id !== board.id);

      // 1. Clean App.tsx (tab/import/content) via the configured LLM.
      reporter.phase('generate');
      reporter.log(`Cleaning generated UI for "${board.title}"...`);
      const cleanupMessage = await removeDashboardFromGeneratedApp(board, remainingBoards, projectDir);
      reporter.log(cleanupMessage);

      // 2. Delete orphaned component files that no remaining dashboard uses.
      reporter.phase('write');
      const removedFiles = await this.deleteOrphanedComponents(board, remainingBoards, projectDir, reporter.progress);

      // 3. Delete the dashboard's protected data so the API stops serving it.
      await this.templateService.deleteProtectedDashboardData(projectDir, board.name);
      reporter.log(`Removed protected data for "${board.name}".`);

      // 4. Code cleanup succeeded — now drop from registry + prompt history.
      this.registry.removeBoard(board.id);

      // 5. Rebuild + push + deploy so the live app no longer shows the dashboard.
      return await this.buildPushDeploy(
        { ...board, outputDir: projectDir },
        ['App.tsx', ...removedFiles],
        `Remove ${board.name}: ${new Date().toISOString()}`,
        reporter,
        run,
      );
    } catch (error: any) {
      return this.failure(run, { board }, error.message);
    } finally {
      lock?.release();
    }
  }

  async updateBoardWithPrompt(
    board: BoardConfig,
    userPrompt: string,
    dataFileOverride?: string,
    onProgress?: UpdateProgress,
    dryRun?: boolean,
  ): Promise<DashboardUpdateResult> {
    const run = dryRun
      ? undefined
      : this.runs.createRun('update', { dashboard: board.name, prompt: userPrompt, dataFile: dataFileOverride });
    const reporter = this.makeReporter(onProgress, run);
    let lock: ReturnType<typeof ProjectLockService.acquire> | undefined;

    try {
      const projectDir = board.outputDir || this.registry.getSharedProjectDir();
      if (!projectDir) {
        return this.failure(run, { board }, 'No generated app workspace found.');
      }
      const dataFile = dataFileOverride ? resolve(dataFileOverride) : board.dataFiles[0];
      if (!dataFile) {
        return this.failure(run, { board }, 'No data source is linked to this dashboard.');
      }

      if (run) {
        run.boardId = board.id;
        run.boardName = board.name;
        run.boardTitle = board.title;
        run.projectDir = projectDir;
        this.runs.save(run);
      }

      reporter.phase('parse');
      reporter.log(`Reading latest data: ${dataFile}`);
      const parsed = await DataParserService.parse(dataFile);

      reporter.phase('analyze');
      const analysis = DataAnalyzer.analyze(parsed);
      const latestSummary = DataAnalyzer.generateSummary(analysis);
      reporter.log(`Parsed latest data (${analysis.rowCount} rows, ${analysis.columnCount} columns)`);

      if (dryRun) {
        reporter.log('Dry run: stopping before generation. No LLM call, no files written.');
        return {
          success: true,
          board,
          plan: {
            title: board.title,
            selector: board.name,
            type: board.type,
            rowCount: analysis.rowCount,
            columnCount: analysis.columnCount,
            dataSummary: latestSummary,
          },
        };
      }

      lock = ProjectLockService.acquire(projectDir);
      if (!lock.success) {
        return this.failure(run, { board }, lock.error ?? 'Project lock failed');
      }

      const { board: updatedBoard, writtenFiles } = await this.generateForBoard(
        board,
        projectDir,
        dataFile,
        parsed,
        latestSummary,
        userPrompt,
        reporter,
        run,
      );
      if (run) {
        run.writtenFiles = writtenFiles;
        this.runs.save(run);
      }

      return await this.buildPushDeploy(
        updatedBoard,
        writtenFiles,
        `Update ${updatedBoard.name}: ${new Date().toISOString()}`,
        reporter,
        run,
      );
    } catch (error: any) {
      return this.failure(run, { board }, error.message);
    } finally {
      lock?.release();
    }
  }

  /**
   * Generate and write a single board's files from a user prompt against
   * already-parsed data, then record the board in the registry + prompt
   * history. Does NOT acquire a lock, build, or deploy — callers compose those.
   * Shared by single-board updates and the bulk "modify all" flow so they
   * deploy the shared workspace exactly once. Throws if the LLM writes nothing.
   */
  private async generateForBoard(
    board: BoardConfig,
    projectDir: string,
    dataFile: string,
    parsed: Awaited<ReturnType<typeof DataParserService.parse>>,
    dataSummary: string,
    userPrompt: string,
    reporter: PipelineReporter,
    run: RunRecord | undefined,
  ): Promise<{ board: BoardConfig; writtenFiles: string[] }> {
    const updatedInputBoard: BoardConfig = {
      ...board,
      outputDir: projectDir,
      dataFiles: [dataFile, ...board.dataFiles.filter((file) => file !== dataFile)],
      dataSummary,
    };
    await this.writeProtectedData(updatedInputBoard, parsed, dataSummary, reporter.progress);

    const prompt = this.buildPromptUpdatePrompt(updatedInputBoard, dataSummary, userPrompt);
    const writtenFiles = await this.generateAndWriteFiles(updatedInputBoard, prompt, reporter, run);
    if (writtenFiles.length === 0) {
      throw new Error('LLM did not return any writable files.');
    }

    const updatedBoard: BoardConfig = {
      ...updatedInputBoard,
      components: [...new Set([...updatedInputBoard.components, ...writtenFiles])],
      generatedAt: new Date().toISOString(),
    };
    this.registry.upsertBoard(updatedBoard);
    this.history.append({
      boardId: updatedBoard.id,
      boardName: updatedBoard.name,
      boardTitle: updatedBoard.title,
      source: 'manual',
      prompt: userPrompt,
      writtenFiles,
      dataSummary,
    });

    return { board: updatedBoard, writtenFiles };
  }

  /**
   * Apply one prompt to EVERY registered dashboard, then build/push/deploy the
   * shared workspace exactly once. Used by the TUI "Modify all dashboards" chat
   * and `openboard agent update --all --prompt "..."`.
   */
  async updateAllWithPrompt(
    userPrompt: string,
    onProgress?: UpdateProgress,
    dataFileOverride?: string,
  ): Promise<DashboardUpdateResult> {
    const reporter = this.makeReporter(onProgress);
    let lock: ReturnType<typeof ProjectLockService.acquire> | undefined;

    try {
      const boards = this.listBoards();
      if (boards.length === 0) {
        return { success: false, error: 'No dashboards are registered.', errorCode: 'E_VALIDATION' };
      }
      const projectDir = this.registry.getSharedProjectDir() || boards[0].outputDir;
      if (!projectDir) {
        return { success: false, error: 'No generated app workspace found.', errorCode: 'E_UNKNOWN' };
      }

      lock = ProjectLockService.acquire(projectDir);
      if (!lock.success) {
        return { success: false, error: lock.error ?? 'Project lock failed', errorCode: 'E_LOCKED' };
      }

      const allWritten: string[] = [];
      let lastBoard: BoardConfig | undefined;
      const failures: string[] = [];
      let modified = 0;
      reporter.log(`Applying to ${boards.length} dashboard(s): "${userPrompt}"`);
      for (let i = 0; i < boards.length; i++) {
        const board = boards[i];
        const label = `${board.title} (${i + 1}/${boards.length})`;
        const dataFile = dataFileOverride ? resolve(dataFileOverride) : board.dataFiles[0];
        if (!dataFile) {
          reporter.log(`Skipping ${label}: no linked data source.`);
          failures.push(`${board.title}: no linked data source`);
          continue;
        }
        try {
          reporter.log(`\n=== Modifying ${label} ===`);
          reporter.phase('parse');
          reporter.log(`Reading data: ${dataFile}`);
          const parsed = await DataParserService.parse(dataFile);
          reporter.phase('analyze');
          const summary = DataAnalyzer.generateSummary(DataAnalyzer.analyze(parsed));
          const result = await this.generateForBoard(
            board,
            projectDir,
            dataFile,
            parsed,
            summary,
            userPrompt,
            reporter,
            undefined,
          );
          allWritten.push(...result.writtenFiles);
          lastBoard = result.board;
          modified += 1;
          reporter.log(`Updated ${label}.`);
        } catch (boardError: any) {
          // Isolate per-board failures so one bad dashboard doesn't abort the
          // whole batch before the shared deploy.
          reporter.log(`Failed to modify ${label}: ${boardError.message}`);
          failures.push(`${board.title}: ${boardError.message}`);
        }
      }

      if (modified === 0) {
        return this.failure(undefined, {}, `No dashboards were modified. ${failures.join('; ')}`.trim());
      }
      if (failures.length > 0) {
        reporter.log(`\nDeploying ${modified} updated dashboard(s); ${failures.length} failed: ${failures.join('; ')}`);
      } else {
        reporter.log(`\nAll ${modified} dashboard(s) updated. Building and deploying once...`);
      }

      return await this.buildPushDeploy(
        { ...(lastBoard ?? boards[0]), outputDir: projectDir },
        [...new Set(allWritten)],
        `Modify all dashboards: ${new Date().toISOString()}`,
        reporter,
        undefined,
      );
    } catch (error: any) {
      return this.failure(undefined, {}, error.message);
    } finally {
      lock?.release();
    }
  }

  /**
   * Remove EVERY dashboard: reset the generated app to the empty OpenBoard
   * shell, delete all dashboard components + protected data, clear the registry
   * + prompt history, then build/push/deploy the shared workspace once. The
   * workspace folder and GitHub/Vercel project are kept. Used by the TUI
   * "Remove all dashboards" option and `openboard agent remove --all`.
   */
  async removeAllDashboards(onProgress?: UpdateProgress): Promise<DashboardUpdateResult> {
    const reporter = this.makeReporter(onProgress);
    let lock: ReturnType<typeof ProjectLockService.acquire> | undefined;

    try {
      const boards = this.listBoards();
      if (boards.length === 0) {
        return { success: false, error: 'No dashboards are registered.', errorCode: 'E_VALIDATION' };
      }
      const projectDir = this.registry.getSharedProjectDir() || boards[0].outputDir;
      if (!projectDir) {
        // No generated workspace — registry-only removal.
        for (const board of boards) this.registry.removeBoard(board.id);
        reporter.log('Removed all dashboards from the registry. No generated app workspace was found.');
        return { success: true };
      }

      lock = ProjectLockService.acquire(projectDir);
      if (!lock.success) {
        return { success: false, error: lock.error ?? 'Project lock failed', errorCode: 'E_LOCKED' };
      }

      reporter.phase('generate');
      reporter.log('Resetting the generated app to the empty OpenBoard shell...');
      await this.templateService.restoreAppShell(projectDir);

      reporter.phase('write');
      const removedFiles: string[] = [];
      for (const board of boards) {
        for (const rawPath of board.components) {
          const normalized = rawPath.replace(/\\/g, '/');
          if (!/^components\/.+\.tsx$/.test(normalized)) continue;     // dashboard components only
          if (/AuthProvider|LoginPage|ThemeToggle|BrandLogo/.test(normalized)) continue; // never the shell
          try {
            await this.templateService.deleteGeneratedFile(projectDir, normalized);
            removedFiles.push(normalized);
          } catch {
            // Path not allowlisted / unsafe — skip rather than risk a wrong delete.
          }
        }
        await this.templateService.deleteProtectedDashboardData(projectDir, board.name);
      }
      reporter.log(`Removed ${removedFiles.length} generated component file(s) and all protected data.`);

      for (const board of boards) this.registry.removeBoard(board.id);
      reporter.log('Cleared the dashboard registry.');

      const placeholder: BoardConfig = {
        id: 'all',
        name: 'openboard-workspace',
        title: 'OpenBoard',
        type: 'custom',
        outputDir: projectDir,
        dataFiles: [],
        components: [],
        createdAt: new Date().toISOString(),
      };
      return await this.buildPushDeploy(
        placeholder,
        ['App.tsx', ...removedFiles],
        `Remove all dashboards: ${new Date().toISOString()}`,
        reporter,
        undefined,
      );
    } catch (error: any) {
      return this.failure(undefined, {}, error.message);
    } finally {
      lock?.release();
    }
  }

  /**
   * Resume a failed run from its last completed phase.
   *
   * If generation already completed (writtenFiles persisted), only the
   * build → push → deploy → verify tail re-runs — no LLM cost. Otherwise the
   * original action is replayed from scratch with its stored options.
   */
  async resume(runId: string, onProgress?: UpdateProgress): Promise<DashboardUpdateResult> {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, error: `Run not found: ${runId}`, errorCode: 'E_RUN_NOT_FOUND' };
    }
    if (run.status === 'succeeded') {
      this.note(onProgress, `Run ${runId} already succeeded; returning its result.`);
      return this.resultFromRun(run);
    }

    const board = run.boardId
      ? this.listBoards().find((b) => b.id === run.boardId)
      : undefined;

    if (
      board &&
      run.writtenFiles && run.writtenFiles.length > 0 &&
      run.projectDir && existsSync(run.projectDir)
    ) {
      this.note(onProgress, `Resuming run ${runId} from build (generation already completed; no LLM cost).`);
      run.status = 'running';
      this.runs.save(run);
      const reporter = this.makeReporter(onProgress, run);
      const lock = ProjectLockService.acquire(run.projectDir);
      if (!lock.success) {
        return this.failure(run, { board }, lock.error ?? 'Project lock failed');
      }
      try {
        return await this.buildPushDeploy(
          { ...board, outputDir: run.projectDir },
          run.writtenFiles,
          `Resume ${board.name}: ${new Date().toISOString()}`,
          reporter,
          run,
        );
      } catch (error: any) {
        return this.failure(run, { board }, error.message);
      } finally {
        lock.release();
      }
    }

    this.note(onProgress, `Resuming run ${runId} by replaying the original ${run.action} action.`);
    const opts = run.options as Record<string, any>;
    switch (run.action) {
      case 'create':
        return this.createFromDataSource({
          dataFile: String(opts.dataFile ?? ''),
          title: opts.title,
          type: opts.type,
          prompt: opts.prompt,
        }, onProgress);
      case 'update':
        return this.updateByPrompt({
          dashboard: String(opts.dashboard ?? ''),
          prompt: String(opts.prompt ?? ''),
          dataFile: opts.dataFile,
        }, onProgress);
      case 'refresh':
        return this.updateBySelector(String(opts.dashboard ?? ''), onProgress);
      default:
        return { success: false, error: `Cannot resume a ${run.action} run.`, errorCode: 'E_VALIDATION' };
    }
  }

  /**
   * Roll the generated app back to the previous deploy tag, then rebuild,
   * push, and redeploy that snapshot.
   */
  async rollback(selector: string, onProgress?: UpdateProgress): Promise<DashboardUpdateResult> {
    const board = this.findBoard(selector);
    if (!board) {
      return { success: false, error: `Dashboard not found: ${selector}`, errorCode: 'E_DASHBOARD_NOT_FOUND' };
    }
    const projectDir = board.outputDir || this.registry.getSharedProjectDir();
    if (!projectDir) {
      return { success: false, board, error: 'No generated app workspace found.', errorCode: 'E_UNKNOWN' };
    }

    const run = this.runs.createRun('rollback', { dashboard: selector });
    run.boardId = board.id;
    run.boardName = board.name;
    run.boardTitle = board.title;
    run.projectDir = projectDir;
    this.runs.save(run);

    const reporter = this.makeReporter(onProgress, run);
    const lock = ProjectLockService.acquire(projectDir);
    if (!lock.success) {
      return this.failure(run, { board }, lock.error ?? 'Project lock failed');
    }
    try {
      reporter.log('Rolling back to the previous deploy tag...');
      const restore = await this.projectManager.restorePreviousDeploy(projectDir, reporter.progress);
      if (!restore.success) {
        return this.failure(run, { board }, restore.error ?? 'Rollback failed');
      }
      return await this.buildPushDeploy(
        { ...board, outputDir: projectDir },
        [],
        `Rollback ${board.name} to ${restore.tag}: ${new Date().toISOString()}`,
        reporter,
        run,
      );
    } catch (error: any) {
      return this.failure(run, { board }, error.message);
    } finally {
      lock.release();
    }
  }

  private buildInitialPrompt(
    board: BoardConfig,
    dataSummary: string,
    userPrompt?: string,
    typeProvided = true,
  ): string {
    const currentApp = this.readCurrentApp(board.outputDir);
    const boards = this.registry.listBoards();
    const intent = resolveInitialIntent({ userPrompt, type: board.type, typeProvided });

    return `Generate an initial dashboard tab for "${board.title}" inside the existing OpenBoard master React app.

This request is coming from an automation agent through the non-interactive OpenBoard CLI.

Dashboard:
- Title: ${board.title}
- Name: ${board.name}
- Type: ${board.type}
- Data file: ${board.dataFiles[0]}

Agent/user intent:
${intent}

Registered dashboards in the shared app:
${boards.map((b) => `- ${b.title} (${b.name}, ${b.type})`).join('\n') || '- none'}

Data analysis:
${dataSummary}

Current src/App.tsx:
${currentApp}

Requirements:
1. Add "${board.title}" as its own dashboard tab in the shared OpenBoard UI.
2. Preserve all existing tabs/components in App.tsx.
3. Preserve AuthProvider, LoginPage, useAuth, the header user greeting (render the signed-in user as "Hi, <username>" via <span className="app-greeting">), and logout behavior.
4. Keep the centered master header text exactly "OpenBoard"; do not replace it with "${board.title}".
5. Load real dashboard rows with useProtectedDashboardData('${board.name}') from src/hooks/useProtectedDashboardData.ts.
6. Do NOT embed raw source rows or sensitive data in App.tsx, component files, or src/data files.
7. Use the actual fields and patterns from the data analysis to create useful metrics/charts.
8. Return all changed files using the required //CODE_START format.`;
  }

  private buildPromptUpdatePrompt(board: BoardConfig, dataSummary: string, userPrompt: string): string {
    const historyText = buildHistoryText(this.history.read(board.id));
    const currentApp = this.readCurrentApp(board.outputDir);
    const boards = this.registry.listBoards();

    return `Update the "${board.title}" dashboard tab according to this agent/user prompt:

${userPrompt}

Dashboard:
- Title: ${board.title}
- Name: ${board.name}
- Type: ${board.type}
- Data file: ${board.dataFiles[0]}

Registered dashboards in the shared app:
${boards.map((b) => `- ${b.title} (${b.name}, ${b.type})`).join('\n') || '- none'}

Latest data analysis:
${dataSummary}

Saved prompt history for this dashboard:
${historyText || '- none'}

Current src/App.tsx:
${currentApp}

Requirements:
1. Apply the requested change only to the "${board.title}" dashboard tab unless the prompt explicitly asks otherwise.
2. Preserve other dashboard tabs/components in the shared OpenBoard app.
3. Preserve AuthProvider, LoginPage, useAuth, the header user greeting (render the signed-in user as "Hi, <username>" via <span className="app-greeting">), and logout behavior.
4. Keep the centered master header text exactly "OpenBoard"; do not replace it with "${board.title}".
5. Load real dashboard rows with useProtectedDashboardData('${board.name}') from src/hooks/useProtectedDashboardData.ts.
6. Do NOT embed raw source rows or sensitive data in App.tsx, component files, or src/data files.
7. Keep the dashboard aligned with the latest data analysis.
8. Return all changed files using the required //CODE_START format.`;
  }

  /** Progress note that reaches both the line callback and the event sink. */
  private note(onProgress: UpdateProgress | undefined, line: string): void {
    onProgress?.(line);
    this.events?.({ event: 'log', message: line });
  }

  private makeReporter(onProgress?: UpdateProgress, run?: RunRecord): PipelineReporter {
    return new PipelineReporter(
      onProgress,
      this.events,
      run ? (phase) => this.runs.markPhase(run, phase) : undefined,
    );
  }

  private failure(
    run: RunRecord | undefined,
    partial: Partial<DashboardUpdateResult>,
    error: string,
  ): DashboardUpdateResult {
    const errorCode = classifyAgentError(error);
    if (run) this.runs.fail(run, error, errorCode);
    this.events?.({ event: 'result', success: false, message: error });
    return { success: false, error, errorCode, runId: run?.runId, ...partial };
  }

  private resultFromRun(run: RunRecord): DashboardUpdateResult {
    const board = run.boardId
      ? this.listBoards().find((b) => b.id === run.boardId)
      : undefined;
    return {
      success: true,
      board,
      writtenFiles: run.writtenFiles,
      deployUrl: run.deployUrl,
      runId: run.runId,
      reused: true,
      tokenUsage: run.tokenUsage,
    };
  }

  private async generateAndWriteFiles(
    board: BoardConfig,
    prompt: string,
    reporter: PipelineReporter,
    run?: RunRecord,
  ): Promise<string[]> {
    const llm = LLMService.createProvider(createLLMConfig(new ConfigService()));
    reporter.phase('generate');
    reporter.log('Generating dashboard code with configured LLM...');
    let usageReported = false;
    const response = await llm.complete({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      // Dashboard components can be large; 4096 truncates them on API providers.
      maxTokens: 8192,
      // Stream liveness so non-interactive agent runners don't treat a long
      // generation as a wedged process and kill it mid-run.
      onProgress: reporter.progress,
      onUsage: (usage) => {
        usageReported = true;
        if (run) this.runs.addTokenUsage(run, { ...usage, estimated: false });
      },
    });
    if (!usageReported && run) {
      this.runs.addTokenUsage(run, {
        promptTokens: estimateTokens(SYSTEM_PROMPT.length + prompt.length),
        completionTokens: estimateTokens(response.length),
        estimated: true,
      });
    }

    const files = extractFiles(response);
    const projectDir = board.outputDir || this.registry.getSharedProjectDir();
    if (!projectDir || files.length === 0) return [];

    reporter.phase('write');
    const writtenFiles: string[] = [];
    for (const file of files) {
      await this.templateService.writeGeneratedFile(projectDir, file.path, file.content);
      writtenFiles.push(file.path);
    }
    reporter.log(`Wrote ${writtenFiles.length} file(s): ${writtenFiles.join(', ')}`);
    return writtenFiles;
  }

  private async writeProtectedData(
    board: BoardConfig,
    parsed: Awaited<ReturnType<typeof DataParserService.parse>>,
    summary: string,
    onProgress?: UpdateProgress,
  ): Promise<void> {
    const projectDir = board.outputDir || this.registry.getSharedProjectDir();
    if (!projectDir) return;
    const path = await this.templateService.writeProtectedDashboardData(projectDir, board.name, {
      rows: parsed.rows,
      headers: parsed.headers,
      format: parsed.format,
      summary,
      generatedAt: new Date().toISOString(),
    });
    onProgress?.(`Wrote protected dashboard data: ${path}`);
  }

  /**
   * Self-healing build: feed the build error (plus an advisory tsc --noEmit
   * signal) and the current generated files back to the LLM for a repair
   * pass, then rebuild. Capped at MAX_REPAIR_ATTEMPTS.
   */
  private async repairAndRebuild(
    projectDir: string,
    writtenFiles: string[],
    buildError: string | undefined,
    reporter: PipelineReporter,
    run?: RunRecord,
  ): Promise<{ success: boolean; error?: string }> {
    let lastError = buildError ?? 'Unknown build error';

    for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      reporter.log(`Build failed — attempting LLM repair (attempt ${attempt}/${MAX_REPAIR_ATTEMPTS})...`);
      try {
        // Advisory type signal — never blocks, only informs the repair.
        let tscSignal = '';
        try {
          const typeResult = await BuildService.typeCheck(projectDir, reporter.progress);
          if (!typeResult.success && typeResult.errors.length > 0) {
            tscSignal = typeResult.errors
              .slice(0, 30)
              .map((e) => `${e.file}(${e.line},${e.column}): ${e.code} ${e.message}`)
              .join('\n');
          }
        } catch {
          // tsc unavailable — proceed with the build error alone
        }

        const fileBlocks = writtenFiles
          .slice(0, 8)
          .map((path) => {
            const fullPath = join(projectDir, 'src', path);
            if (!existsSync(fullPath)) return '';
            const content = readFileSync(fullPath, 'utf-8').slice(0, 12000);
            return `//CODE_START path=${path}\n${content}\n//CODE_END`;
          })
          .filter(Boolean)
          .join('\n\n');

        const repairPrompt = `The generated dashboard code failed to build. Fix the build errors and return corrected files.

Build error output:
${lastError.slice(0, 6000)}
${tscSignal ? `\nTypeScript check (advisory):\n${tscSignal}` : ''}

Current generated files:
${fileBlocks}

Requirements:
1. Return ONLY the files that need changes, using the required //CODE_START format.
2. Fix all build errors without changing dashboard behavior or removing features.
3. Preserve AuthProvider, LoginPage, useAuth wiring and all dashboard tabs.
4. Do not introduce new dependencies.`;

        const llm = LLMService.createProvider(createLLMConfig(new ConfigService()));
        const response = await llm.complete({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: repairPrompt },
          ],
          temperature: 0.1,
          maxTokens: 8192,
          onProgress: reporter.progress,
          onUsage: (usage) => {
            if (run) this.runs.addTokenUsage(run, { ...usage, estimated: false });
          },
        });

        const files = extractFiles(response);
        if (files.length === 0) {
          reporter.log('Repair attempt returned no files; keeping previous error.');
          continue;
        }

        let repaired = 0;
        for (const file of files) {
          try {
            await this.templateService.writeGeneratedFile(projectDir, file.path, file.content);
            repaired++;
          } catch {
            // Disallowed path from the repair response — skip it.
          }
        }
        reporter.log(`Repair wrote ${repaired} file(s); rebuilding...`);

        const rebuild = await this.projectManager.build(projectDir, reporter.progress);
        if (rebuild.success) {
          reporter.log(`Build repaired on attempt ${attempt}.`);
          return { success: true };
        }
        lastError = rebuild.error ?? lastError;
      } catch (err: any) {
        // e.g. no LLM configured, provider auth failure — repair cannot proceed.
        reporter.log(`Repair attempt failed: ${err.message}`);
        break;
      }
    }

    return { success: false, error: lastError };
  }

  private async buildPushDeploy(
    board: BoardConfig,
    writtenFiles: string[],
    commitMessage: string,
    reporter: PipelineReporter,
    run?: RunRecord,
  ): Promise<DashboardUpdateResult> {
    const projectDir = board.outputDir || this.registry.getSharedProjectDir();
    if (!projectDir) {
      return this.failure(run, { board, writtenFiles }, 'No generated app workspace found.');
    }

    reporter.phase('build');
    const info = this.projectManager.getProjectInfo(projectDir);
    if (info && !info.hasNodeModules) {
      reporter.log('Installing dependencies...');
      const installResult = await this.projectManager.install(projectDir, reporter.progress);
      if (!installResult.success) {
        return this.failure(run, { board, writtenFiles }, `Install failed: ${installResult.error}`);
      }
    }

    reporter.log('Building project...');
    let buildResult: { success: boolean; error?: string } = await this.projectManager.build(projectDir, reporter.progress);
    if (!buildResult.success && writtenFiles.length > 0) {
      buildResult = await this.repairAndRebuild(projectDir, writtenFiles, buildResult.error, reporter, run);
    }
    if (!buildResult.success) {
      return this.failure(run, { board, writtenFiles }, `Build failed: ${buildResult.error}`);
    }
    reporter.log('Build successful');

    reporter.phase('push');
    reporter.log('Pushing to GitHub...');
    const pushResult = await this.projectManager.commitAndPush(projectDir, commitMessage, reporter.progress);
    const pushedToGitHub = pushResult.success && pushResult.pushed === true;
    if (!pushResult.success) {
      reporter.log(`GitHub push skipped/failed: ${pushResult.error || 'Unknown error'}`);
      reporter.log('Continuing with Vercel deployment...');
    }

    reporter.phase('deploy');
    reporter.log('Deploying to Vercel...');
    const deployResult = await this.projectManager.deploy(projectDir, reporter.progress);
    if (!deployResult.success) {
      if (pushedToGitHub && isVercelAuthError(deployResult.error)) {
        reporter.log('Pushed to GitHub. Vercel Git integration should deploy this commit automatically.');
        reporter.log('Direct Vercel CLI deploy was skipped because local Vercel auth is not available.');
        reporter.phase('done');
        reporter.result(true);
        if (run) {
          this.runs.complete(run, {
            boardId: board.id, boardName: board.name, boardTitle: board.title,
            projectDir, writtenFiles,
          });
        }
        return { success: true, board, writtenFiles, runId: run?.runId, tokenUsage: run?.tokenUsage };
      }
      return this.failure(run, { board, writtenFiles }, `Deploy failed: ${deployResult.error}`);
    }

    // Tag the deploy so rollback has a stable target (best-effort).
    const tagResult = await this.projectManager.tagDeploy(projectDir, reporter.progress);

    let verified: boolean | undefined;
    if (deployResult.url) {
      reporter.phase('verify');
      const verification = await DeployVerificationService.verify(deployResult.url, reporter.progress);
      verified = verification.success;
      if (!verified) {
        reporter.log(`Warning: deployed, but ${verification.error}`);
      }
    }

    reporter.log(`Deployed: ${deployResult.url || 'Success'}`);
    reporter.phase('done');
    reporter.result(true);
    if (run) {
      this.runs.complete(run, {
        boardId: board.id, boardName: board.name, boardTitle: board.title,
        projectDir, writtenFiles, deployUrl: deployResult.url,
      });
    }
    return {
      success: true,
      board,
      writtenFiles,
      deployUrl: deployResult.url,
      deployTag: tagResult.tag,
      verified,
      runId: run?.runId,
      tokenUsage: run?.tokenUsage,
    };
  }

  private readCurrentApp(projectDir: string): string {
    const appPath = join(projectDir, 'src', 'App.tsx');
    return existsSync(appPath) ? readFileSync(appPath, 'utf-8').slice(0, 12000) : '';
  }

  /**
   * Delete component files that belonged only to the removed dashboard.
   *
   * Conservative on purpose — a file is deleted only when it is a dashboard
   * component (components/*.tsx), is not the shared auth shell, is not claimed
   * by any remaining dashboard, and is no longer referenced by the cleaned
   * App.tsx. Returns the relative paths that were deleted.
   */
  private async deleteOrphanedComponents(
    board: BoardConfig,
    remainingBoards: BoardConfig[],
    projectDir: string,
    onProgress?: UpdateProgress,
  ): Promise<string[]> {
    const appPath = join(projectDir, 'src', 'App.tsx');
    const cleanedApp = existsSync(appPath) ? readFileSync(appPath, 'utf-8') : '';
    const keepPaths = new Set(
      remainingBoards.flatMap((b) => b.components.map((p) => p.replace(/\\/g, '/'))),
    );

    const removed: string[] = [];
    for (const rawPath of board.components) {
      const normalized = rawPath.replace(/\\/g, '/');
      if (!/^components\/.+\.tsx$/.test(normalized)) continue;       // dashboard components only
      if (/AuthProvider|LoginPage/.test(normalized)) continue;       // never the auth shell
      if (keepPaths.has(normalized)) continue;                       // still owned by another board

      const baseName = normalized.replace(/^.*\//, '').replace(/\.tsx$/, '');
      if (cleanedApp.includes(baseName)) continue;                   // still referenced by App.tsx

      try {
        await this.templateService.deleteGeneratedFile(projectDir, normalized);
        removed.push(normalized);
        onProgress?.(`Removed orphaned component: src/${normalized}`);
      } catch {
        // Path not allowlisted / unsafe — skip rather than risk deleting the wrong file.
      }
    }
    return removed;
  }
}

export default DashboardUpdateService;
