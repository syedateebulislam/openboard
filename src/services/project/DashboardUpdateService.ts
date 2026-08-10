import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { normalizeUserPath } from '../../utils/pathNormalizer.js';
import { createHash, randomUUID } from 'node:crypto';
import { createBoardConfig, getPreset } from '../../config/boardPresets.js';
import { MASTER_DASHBOARD_PROMPT, resolveInitialIntent } from '../../config/dashboardPrompts.js';
import { getAppMode, modeAllowsDeploy } from '../../config/appModes.js';
import { TypedConfigRepository } from '../config/TypedConfigRepository.js';
import { DataAnalyzer } from '../data/DataAnalyzer.js';
import { DataParserService } from '../data/DataParserService.js';
import { LLMService } from '../llm/LLMService.js';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_LOW } from '../llm/prompts/systemPrompt.js';
import { TemplateService } from '../template/TemplateService.js';
import { BuildService } from '../build/BuildService.js';
import { DeployVerificationService } from '../deploy/DeployVerificationService.js';
import { extractFiles } from '../../utils/codeExtractor.js';
import { classifyAgentError } from '../../utils/errorCodes.js';
import type { BoardConfig } from '../../types/board.js';
import { BoardRegistryService } from './BoardRegistryService.js';
import { PromptHistoryService } from './PromptHistoryService.js';
import { ProjectLockService } from './ProjectLockService.js';
import { ProjectManager } from './ProjectManager.js';
import { PipelineReporter } from './pipelinePhases.js';
import type { PipelineEventSink } from './pipelinePhases.js';
import { RunStateService } from './RunStateService.js';
import type { RunRecord, RunTokenUsage } from './RunStateService.js';
import { DashboardManifestService } from './DashboardManifestService.js';
import { DashboardBuildPipeline } from './DashboardBuildPipeline.js';
import { RefreshAllDashboardsUseCase } from './useCases/RefreshAllDashboardsUseCase.js';

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
  /** UI generation complexity. 'low' is for local/small-context models. Defaults to 'high'. */
  quality?: BoardConfig['uiQuality'];
}

export interface PromptUpdateOptions {
  dashboard: string;
  prompt: string;
  dataFile?: string;
  dryRun?: boolean;
}

interface RefreshExecutionOptions {
  /** Batch refresh already owns the workspace lock. */
  lockHeld?: boolean;
  /** Generate/register only; the batch performs one final build/deploy. */
  deferFinalize?: boolean;
  /** Force every board in a batch to use the shared workspace. */
  projectDir?: string;
}

// Default models come from the shared catalog (src/config/llmCatalog.ts).

function isGeneratedPathRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith('Generated file path is not allowed:') ||
    error.message.startsWith('Unsafe generated file path:')
  );
}

/**
 * Match a board by id, name or title, treating spaces, hyphens and underscores
 * as the same separator.
 *
 * Board names come from sanitizeBoardName, which turns every separator into a
 * hyphen: "Uber Rides" is stored as `uber-rides`. Biller keys keep the
 * underscore the fetcher declares — `uber_rides` — so a raw string compare
 * never matched them, and the invoice pipeline concluded the dashboard did not
 * exist. Every scheduled fetch then rebuilt and redeployed it from scratch,
 * with no new invoices, for as long as the biller stayed enabled. Only keys
 * containing a separator were affected, which is why `amazon` looked fine while
 * `uber_rides` and `swiggy_instamart` deployed on every run.
 *
 * Widening this cannot introduce ambiguity: sanitizeBoardName only ever emits
 * hyphens, so two boards differing solely by separator cannot both exist.
 */
function matchesBoard(board: BoardConfig, selector: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '-');
  const normalized = normalize(selector);
  return [board.id, board.name, board.title].some((value) => normalize(value) === normalized);
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

  const llm = LLMService.createProvider(new TypedConfigRepository().requireLLMConfig());
  const currentApp = readFileSync(appPath, 'utf-8');
  const prompt = `${SYSTEM_PROMPT}

Task: remove one dashboard from the existing shared OpenBoardCLI app.

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
4. Preserve every remaining dashboard and its imports, and preserve the master 'Overview' tab (id 'master') as the first tab if present.
5. Preserve the OpenBoardCLI header shell exactly: <HeaderLinks /> on the left, the clickable app-brand button with <h1 className="app-title">OpenBoardCLI</h1>, and the greeting/ThemeToggle/Logout on the right.
6. Do not modify unrelated styling or auth behavior, and do not re-add a Welcome tab while dashboards remain.`;

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

/**
 * Boards that should record this deployment.
 *
 * A workspace is one Vercel project serving every dashboard in it as tabs, so
 * a deploy publishes all of them at once. Recording the URL against only the
 * board that triggered the run left its siblings reading "never deployed"
 * while they were live at that very address — and nothing wrote the field at
 * all, so every board reported that regardless.
 *
 * Boards already carrying this exact URL are skipped so a repeat deploy does
 * not rewrite the registry for no reason.
 */
export function boardsNeedingDeployRecord(
  boards: BoardConfig[],
  projectDir: string,
  deployUrl: string,
): BoardConfig[] {
  const target = resolve(projectDir);
  return boards.filter((board) => {
    if (resolve(board.outputDir) !== target) return false;
    return !(board.deployUrl === deployUrl && board.lastDeployed);
  });
}

export class DashboardUpdateService {
  private registry: BoardRegistryService;
  private history: PromptHistoryService;
  private projectManager: ProjectManager;
  private templateService: TemplateService;
  private events?: PipelineEventSink;
  private runs: RunStateService;
  private manifest: DashboardManifestService;

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
    this.manifest = new DashboardManifestService(templateService);
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
      const dataFile = resolve(normalizeUserPath(options.dataFile));
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
        uiQuality: options.quality,
      };

      reporter.log(`Preparing OpenBoardCLI workspace for "${board.title}"...`);
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

      const masterFiles = await this.syncMasterTab(scaffold.projectDir, reporter, run);

      return await this.buildPushDeploy(
        updatedBoard,
        [...new Set([...writtenFiles, ...masterFiles])],
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
    signal?: AbortSignal,
  ): Promise<DashboardUpdateResult> {
    const board = this.findBoard(options.dashboard);
    if (!board) {
      return {
        success: false,
        error: `Dashboard not found: ${options.dashboard}`,
        errorCode: 'E_DASHBOARD_NOT_FOUND',
      };
    }
    return this.updateBoardWithPrompt(board, options.prompt, options.dataFile, onProgress, options.dryRun, signal);
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
    return new RefreshAllDashboardsUseCase({
      listBoards: () => this.listBoards(),
      projectDir: (boards) => this.registry.getSharedProjectDir() || boards[0]?.outputDir,
      acquireLock: (projectDir) => ProjectLockService.acquire(projectDir),
      refresh: (board, projectDir, progress) => this.updateBoard(board, progress, {
        lockHeld: true,
        deferFinalize: true,
        projectDir,
      }),
      syncComposition: async (projectDir, progress) => this.syncMasterTab(
        projectDir,
        this.makeReporter(progress),
      ),
      finalize: (board, writtenFiles, count, progress) => this.buildPushDeploy(
        board,
        writtenFiles,
        `Regenerate ${count} dashboard(s): ${new Date().toISOString()}`,
        this.makeReporter(progress),
      ),
      reconcile: (results, finalized, projectDir) => this.reconcileBatchResults(results, finalized, projectDir),
      failure: (board, message, errorCode) => ({
        success: false,
        board,
        error: message,
        errorCode: errorCode ?? classifyAgentError(message),
      }),
    }).execute(onProgress);
  }

  async updateBoard(
    board: BoardConfig,
    onProgress?: UpdateProgress,
    execution: RefreshExecutionOptions = {},
  ): Promise<DashboardUpdateResult> {
    const run = this.runs.createRun('refresh', { dashboard: board.name });
    const reporter = this.makeReporter(onProgress, run);
    let lock: ReturnType<typeof ProjectLockService.acquire> | undefined;

    try {
      const projectDir = execution.projectDir || board.outputDir || this.registry.getSharedProjectDir();
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

      if (!execution.lockHeld) {
        lock = ProjectLockService.acquire(projectDir);
        if (!lock.success) {
          return this.failure(run, { board }, lock.error ?? 'Project lock failed');
        }
      }

      await this.writeProtectedData(board, parsed, latestSummary, reporter.progress);

      const boards = this.registry.listBoards();
      const historyText = promptHistory
        .map((entry, index) => `${index + 1}. [${entry.source}] ${entry.prompt}`)
        .join('\n\n');

      const prompt = `Regenerate/update the "${board.title}" dashboard tab using the latest data source.

This is a non-interactive OpenBoardCLI update run. The data file (CSV/Excel/JSON) may have changed, but the dashboard intent must remain the same as the saved prompt history.

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

Requirements:
1. Preserve the same dashboard tab and user-requested insights represented by the prompt history.
2. Update metrics, charts, tables, and data processing to reflect the latest data analysis.
3. Return one primary exported dashboard component plus only its required helper files.
4. Do not return App.tsx, navigation, authentication, generated/dashboardManifest.tsx, or components/MasterDashboard.tsx; OpenBoardCLI owns those files.
5. Return all changed files using the required //CODE_START format.`;

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

      if (execution.deferFinalize) {
        return {
          success: true,
          board: updatedBoard,
          writtenFiles,
          runId: run.runId,
          tokenUsage: run.tokenUsage,
        };
      }

      const masterFiles = await this.syncMasterTab(projectDir, reporter, run);

      return await this.buildPushDeploy(
        updatedBoard,
        [...new Set([...writtenFiles, ...masterFiles])],
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
   *  1. Deterministic manifest removal of the tab/import/content.
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

      // 1. App.tsx/tab composition is product-owned. Removing a dashboard only
      //    changes registry data; the manifest is regenerated before build.
      reporter.phase('generate');
      if (remainingBoards.length === 0) {
        reporter.log('Removing the last dashboard — restoring the empty OpenBoardCLI shell...');
        await this.templateService.restoreAppShell(projectDir);
        await this.templateService.deleteGeneratedFile(projectDir, 'components/MasterDashboard.tsx');
        this.registry.setMasterState(undefined);
      } else {
        reporter.log(`Removing "${board.title}" from the deterministic dashboard manifest...`);
      }

      // 2. Delete orphaned component files that no remaining dashboard uses.
      reporter.phase('write');
      const removedFiles = await this.deleteOrphanedComponents(board, remainingBoards, projectDir, reporter.progress);

      // 3. Delete the dashboard's protected data so the API stops serving it.
      await this.templateService.deleteProtectedDashboardData(projectDir, board.name);
      reporter.log(`Removed protected data for "${board.name}".`);

      // 4. Code cleanup succeeded — now drop from registry + prompt history.
      this.registry.removeBoard(board.id);

      // 5. Refresh the master Overview tab against the remaining dashboards.
      const masterFiles = remainingBoards.length > 0
        ? await this.syncMasterTab(projectDir, reporter, run)
        : [];

      // 6. Rebuild + push + deploy so the live app no longer shows the dashboard.
      return await this.buildPushDeploy(
        { ...board, outputDir: projectDir },
        [...new Set(['App.tsx', ...removedFiles, ...masterFiles])],
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
    signal?: AbortSignal,
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
      const dataFile = dataFileOverride ? resolve(normalizeUserPath(dataFileOverride)) : board.dataFiles[0];
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
        signal,
      );
      if (run) {
        run.writtenFiles = writtenFiles;
        this.runs.save(run);
      }

      const masterFiles = await this.syncMasterTab(projectDir, reporter, run);

      return await this.buildPushDeploy(
        updatedBoard,
        [...new Set([...writtenFiles, ...masterFiles])],
        `Update ${updatedBoard.name}: ${new Date().toISOString()}`,
        reporter,
        run,
        signal,
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
    signal?: AbortSignal,
  ): Promise<{ board: BoardConfig; writtenFiles: string[] }> {
    const updatedInputBoard: BoardConfig = {
      ...board,
      outputDir: projectDir,
      dataFiles: [dataFile, ...board.dataFiles.filter((file) => file !== dataFile)],
      dataSummary,
    };
    await this.writeProtectedData(updatedInputBoard, parsed, dataSummary, reporter.progress);

    const prompt = this.buildPromptUpdatePrompt(updatedInputBoard, dataSummary, userPrompt);
    const writtenFiles = await this.generateAndWriteFiles(updatedInputBoard, prompt, reporter, run, signal);
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
    signal?: AbortSignal,
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
        if (signal?.aborted) {
          failures.push('Stopped by user before all dashboards were modified.');
          break;
        }
        const board = boards[i];
        const label = `${board.title} (${i + 1}/${boards.length})`;
        const dataFile = dataFileOverride ? resolve(normalizeUserPath(dataFileOverride)) : board.dataFiles[0];
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
            signal,
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

      allWritten.push(...await this.syncMasterTab(projectDir, reporter, undefined));

      return await this.buildPushDeploy(
        { ...(lastBoard ?? boards[0]), outputDir: projectDir },
        [...new Set(allWritten)],
        `Modify all dashboards: ${new Date().toISOString()}`,
        reporter,
        undefined,
        signal,
      );
    } catch (error: any) {
      return this.failure(undefined, {}, error.message);
    } finally {
      lock?.release();
    }
  }

  /**
   * Remove EVERY dashboard: reset the generated app to the empty OpenBoardCLI
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
      reporter.log('Resetting the generated app to the empty OpenBoardCLI shell...');
      await this.templateService.restoreAppShell(projectDir);
      await this.templateService.deleteGeneratedFile(projectDir, 'components/MasterDashboard.tsx');
      this.registry.setMasterState(undefined);

      reporter.phase('write');
      const removedFiles: string[] = [];
      for (const board of boards) {
        for (const rawPath of board.components) {
          const normalized = rawPath.replace(/\\/g, '/');
          if (!/^components\/.+\.tsx$/.test(normalized)) continue;     // dashboard components only
          if (/AuthProvider|LoginPage|ThemeToggle|BrandLogo|ErrorBoundary/.test(normalized)) continue; // never the shell
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
        title: 'OpenBoardCLI',
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
  async resume(runId: string, onProgress?: UpdateProgress, signal?: AbortSignal): Promise<DashboardUpdateResult> {
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
          signal,
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
        }, onProgress, signal);
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

  /** Hash of the dashboard set the master tab depends on. Data refreshes do
   *  not change it — MasterDashboard computes everything at runtime from the
   *  protected API, so only adding/removing/renaming dashboards matters. */
  private masterStateHash(boards: BoardConfig[]): string {
    const signature = boards
      .map((board) => `${board.name}|${board.title}`)
      .sort()
      .join('\n');
    return createHash('sha256').update(signature).digest('hex');
  }

  /**
   * Generate or refresh the master "Overview" component. App.tsx and its
   * manifest are product-owned. Skips the
   * LLM call when the dashboard set is unchanged and the component exists.
   * Failures are non-fatal: the pipeline continues with the per-dashboard
   * changes, and the stored state is left untouched so the next dashboard
   * operation retries. Returns the written file paths (for the repair loop).
   * Public so the TUI chat's build/deploy flows can refresh the master tab too.
   */
  async syncMasterTab(
    projectDir: string,
    reporter: PipelineReporter,
    run?: RunRecord,
  ): Promise<string[]> {
    try {
      const boards = this.registry.listBoards();
      const masterPath = join(projectDir, 'src', 'components', 'MasterDashboard.tsx');

      if (boards.length === 0) {
        await this.templateService.deleteGeneratedFile(projectDir, 'components/MasterDashboard.tsx');
        this.registry.setMasterState(undefined);
        return [];
      }

      const hash = this.masterStateHash(boards);
      if (this.registry.getMasterState()?.hash === hash && existsSync(masterPath)) {
        reporter.log('Master Overview tab is up to date.');
        return [];
      }

      reporter.log(`Generating the master Overview tab across ${boards.length} dashboard(s)...`);
      const prompt = `${MASTER_DASHBOARD_PROMPT}

Registered dashboards (ALL must be represented in the master overview; their slugs key data.dashboards):
${boards.map((b) => `- ${b.title} (slug: ${b.name}, type: ${b.type})${b.dataSummary ? `\n  Data analysis: ${b.dataSummary.slice(0, 1500)}` : ''}`).join('\n')}

Requirements:
1. Return ONLY components/MasterDashboard.tsx plus optional utils/ helpers using the required //CODE_START format.
2. Export MasterDashboard as a named or default React component.
3. Do not return App.tsx, tabs, navigation, authentication, or generated/dashboardManifest.tsx.
4. MasterDashboard loads data ONLY via useAllDashboardsData() and follows the exactly-4 Top Insights rule (2 spending + 2 saving).`;

      const placeholderBoard: BoardConfig = {
        id: 'master',
        name: 'master-overview',
        title: 'Overview',
        type: 'custom',
        outputDir: projectDir,
        dataFiles: [],
        components: [],
        createdAt: new Date().toISOString(),
      };
      const writtenFiles = await this.generateAndWriteFiles(placeholderBoard, prompt, reporter, run);
      if (writtenFiles.length === 0) {
        reporter.log('Warning: master tab generation returned no files; will retry on the next dashboard operation.');
        return [];
      }
      this.registry.setMasterState({ hash, generatedAt: new Date().toISOString() });
      reporter.log('Master Overview tab updated.');
      return writtenFiles;
    } catch (error: any) {
      reporter.log(`Warning: master tab generation failed — will retry on the next dashboard operation: ${error.message}`);
      return [];
    }
  }

  private buildInitialPrompt(
    board: BoardConfig,
    dataSummary: string,
    userPrompt?: string,
    typeProvided = true,
  ): string {
    const boards = this.registry.listBoards();
    const intent = resolveInitialIntent({ userPrompt, type: board.type, typeProvided });

    return `Generate an initial dashboard tab for "${board.title}" inside the existing OpenBoardCLI master React app.

This request is coming from an automation agent through the non-interactive OpenBoardCLI CLI.

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

Requirements:
1. Return one primary exported dashboard component for "${board.title}" and any helper files it requires.
2. Do not return App.tsx, tabs, navigation, authentication, generated/dashboardManifest.tsx, or components/MasterDashboard.tsx.
3. Load real dashboard rows with useProtectedDashboardData('${board.name}') from src/hooks/useProtectedDashboardData.ts.
4. Do NOT embed raw source rows or sensitive data in component files or frontend data files.
5. Use the actual fields and patterns from the data analysis to create useful metrics/charts.
6. Return all changed files using the required //CODE_START format.${board.uiQuality === 'low' ? '\n7. Keep it simple: 1-3 KPI/metric cards and exactly one chart is enough — prioritize finishing complete, valid code over feature richness.' : ''}`;
  }

  private buildPromptUpdatePrompt(board: BoardConfig, dataSummary: string, userPrompt: string): string {
    const historyText = buildHistoryText(this.history.read(board.id));
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

Requirements:
1. Apply the requested change only to the "${board.title}" dashboard tab unless the prompt explicitly asks otherwise.
2. Return the updated primary dashboard component and only its required helpers.
3. Do not return App.tsx, navigation, authentication, generated/dashboardManifest.tsx, or components/MasterDashboard.tsx unless explicitly targeting the master overview.
4. Load real dashboard rows with useProtectedDashboardData('${board.name}') from src/hooks/useProtectedDashboardData.ts.
5. Do NOT embed raw source rows or sensitive data in component files or frontend data files.
6. Keep the dashboard aligned with the latest data analysis.
7. Return all changed files using the required //CODE_START format.${board.uiQuality === 'low' ? '\n8. Keep it simple: 1-3 KPI/metric cards and exactly one chart is enough — prioritize finishing complete, valid code over feature richness.' : ''}`;
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
    signal?: AbortSignal,
  ): Promise<string[]> {
    const llm = LLMService.createProvider(new TypedConfigRepository().requireLLMConfig());
    const systemPrompt = board.uiQuality === 'low' ? SYSTEM_PROMPT_LOW : SYSTEM_PROMPT;
    // A local model's *total* context (prompt + completion) is often small —
    // trimming the system prompt alone isn't enough if the completion budget
    // still assumes a large-context provider.
    const maxTokens = board.uiQuality === 'low' ? 4096 : 8192;
    reporter.phase('generate');
    reporter.log('Generating dashboard code with configured LLM...');
    let usageReported = false;
    const response = await llm.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      maxTokens,
      // Stream liveness so non-interactive agent runners don't treat a long
      // generation as a wedged process and kill it mid-run.
      onProgress: reporter.progress,
      onUsage: (usage) => {
        usageReported = true;
        if (run) this.runs.addTokenUsage(run, { ...usage, estimated: false });
      },
      signal,
    });
    if (!usageReported && run) {
      this.runs.addTokenUsage(run, {
        promptTokens: estimateTokens(systemPrompt.length + prompt.length),
        completionTokens: estimateTokens(response.length),
        estimated: true,
      });
    }

    const extracted = extractFiles(response);
    const files = extracted.filter(
      (file) => file.path !== 'App.tsx' && !file.path.startsWith('generated/'),
    );
    if (files.length !== extracted.length) {
      reporter.log('Ignored LLM App.tsx/generated output; OpenBoardCLI owns shell and tab composition.');
    }
    const projectDir = board.outputDir || this.registry.getSharedProjectDir();
    if (!projectDir || files.length === 0) return [];

    reporter.phase('write');
    const writtenFiles: string[] = [];
    for (const file of files) {
      try {
        await this.templateService.writeGeneratedFile(projectDir, file.path, file.content);
        writtenFiles.push(file.path);
      } catch (error) {
        if (!isGeneratedPathRejection(error)) throw error;
        // Disallowed path (e.g. a stray App.css block — shell-owned since the
        // allowlist change) — skip it rather than abort the whole pipeline.
        reporter.log(`Skipped disallowed generated file: ${file.path}`);
      }
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
    uiQuality?: BoardConfig['uiQuality'],
  ): Promise<{ success: boolean; error?: string }> {
    let lastError = buildError ?? 'Unknown build error';
    let anyAttemptProducedFiles = false;

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

        const llm = LLMService.createProvider(new TypedConfigRepository().requireLLMConfig());
        const response = await llm.complete({
          messages: [
            { role: 'system', content: uiQuality === 'low' ? SYSTEM_PROMPT_LOW : SYSTEM_PROMPT },
            { role: 'user', content: repairPrompt },
          ],
          temperature: 0.1,
          maxTokens: uiQuality === 'low' ? 4096 : 8192,
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
        anyAttemptProducedFiles = true;

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

    if (!anyAttemptProducedFiles) {
      return {
        success: false,
        error: `${lastError}\n\nAll ${MAX_REPAIR_ATTEMPTS} automatic repair attempt(s) returned no code at all. This usually means the configured LLM spent its entire response budget on internal reasoning without producing an answer — common with local "thinking" models under token pressure. Try a smaller/non-reasoning local model, increase the model's max output tokens in your local server settings, or fix the build manually.`,
      };
    }
    return { success: false, error: lastError };
  }

  private async buildPushDeploy(
    board: BoardConfig,
    writtenFiles: string[],
    commitMessage: string,
    reporter: PipelineReporter,
    run?: RunRecord,
    signal?: AbortSignal,
  ): Promise<DashboardUpdateResult> {
    const projectDir = board.outputDir || this.registry.getSharedProjectDir();
    if (!projectDir) {
      return this.failure(run, { board, writtenFiles }, 'No generated app workspace found.');
    }

    const buildPipeline = new DashboardBuildPipeline({
      boards: () => this.registry.listBoards(),
      syncManifest: (dir, boards) => this.manifest.sync(dir, boards),
      syncShell: (dir) => this.templateService.syncShellFiles(dir),
      hasDependencies: (dir) => this.projectManager.getProjectInfo(dir)?.hasNodeModules ?? true,
      install: (dir, progress) => this.projectManager.install(dir, progress, signal),
      build: (dir, progress) => this.projectManager.build(dir, progress, signal),
      repair: (dir, files, error) => this.repairAndRebuild(dir, files, error, reporter, run, board.uiQuality),
    });
    const buildResult = await buildPipeline.execute(projectDir, writtenFiles, reporter);
    if (!buildResult.success) {
      return this.failure(run, { board, writtenFiles }, buildResult.error ?? 'Build failed.');
    }

    // Mode contract: only the deploying modes publish. The preview-only
    // pipelines (local, hybrid) end at the local build — the user previews the
    // dashboard on their machine.
    const mode = getAppMode();
    if (!modeAllowsDeploy(mode)) {
      reporter.log(`Mode is ${mode} — GitHub push and Vercel deploy are skipped by design.`);
      reporter.log(`Preview locally: /preview in the TUI, or \`npm run dev\` in ${projectDir}`);
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

    reporter.phase('push');
    reporter.log('Pushing to GitHub...');
    const pushResult = await this.projectManager.commitAndPush(projectDir, commitMessage, reporter.progress, signal);
    const pushedToGitHub = pushResult.success && pushResult.pushed === true;
    if (!pushResult.success) {
      reporter.log(`GitHub push skipped/failed: ${pushResult.error || 'Unknown error'}`);
      reporter.log('Continuing with Vercel deployment...');
    }

    reporter.phase('deploy');
    reporter.log('Deploying to Vercel...');
    const deployResult = await this.projectManager.deploy(projectDir, reporter.progress, signal);
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
      // A protected deployment is not a failed one — the checker simply cannot
      // see past the auth wall, and warning about it taught users to ignore a
      // line that is meant to matter.
      if (!verified && !verification.protected) {
        reporter.log(`Warning: deployed, but ${verification.error}`);
      }
    }

    reporter.log(`Deployed: ${deployResult.url || 'Success'}`);
    reporter.phase('done');
    reporter.result(true);
    this.recordDeployment(projectDir, deployResult.url, reporter);

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

  /**
   * Persist the deployment onto every board that shares this project.
   *
   * BoardConfig has always declared deployUrl and lastDeployed, and `agent
   * list` reports them — but nothing ever wrote them, so every board read as
   * "never deployed" no matter how many times it had shipped.
   *
   * They are written across the whole project directory rather than onto the
   * board that happened to trigger the run, because a workspace is one Vercel
   * project serving every dashboard in it as tabs. Recording the URL against a
   * single board would leave its siblings looking undeployed while they are
   * live at that very address.
   */
  private recordDeployment(projectDir: string, deployUrl?: string, reporter?: PipelineReporter): void {
    if (!deployUrl) {
      reporter?.log('Deploy returned no URL — nothing recorded against the boards.');
      return;
    }
    const lastDeployed = new Date().toISOString();
    const targets = boardsNeedingDeployRecord(this.registry.listBoards(), projectDir, deployUrl);
    for (const board of targets) {
      this.registry.upsertBoard({ ...board, deployUrl, lastDeployed });
    }
    // Stated in the deploy log because the write itself is invisible: boards
    // reported "never deployed" for a long time purely because nothing ever
    // persisted the URL, and there was no output that would have shown it.
    reporter?.log(
      targets.length > 0
        ? `Recorded deployment on ${targets.length} board(s) in this workspace.`
        : 'Boards already carried this deployment — nothing to record.',
    );
  }

  private reconcileBatchResults(
    results: DashboardUpdateResult[],
    finalized: DashboardUpdateResult,
    projectDir: string,
  ): DashboardUpdateResult[] {
    return results.map((result) => {
      if (!result.success || !result.board) return result;
      const run = result.runId ? this.runs.get(result.runId) : undefined;
      if (!finalized.success) {
        const error = finalized.error ?? 'Batch build/deploy failed.';
        if (run) this.runs.fail(run, error, finalized.errorCode);
        return { ...result, success: false, error, errorCode: finalized.errorCode };
      }
      if (run) {
        this.runs.complete(run, {
          boardId: result.board.id,
          boardName: result.board.name,
          boardTitle: result.board.title,
          projectDir,
          writtenFiles: result.writtenFiles,
          deployUrl: finalized.deployUrl,
        });
      }
      return {
        ...result,
        deployUrl: finalized.deployUrl,
        verified: finalized.verified,
        tokenUsage: run?.tokenUsage,
      };
    });
  }

  /**
   * Delete component files that belonged only to the removed dashboard.
   *
   * Conservative on purpose — a file is deleted only when it is a dashboard
   * component (components/*.tsx), is not the shared auth shell, is not claimed
   * by any remaining dashboard. Returns the relative paths that were deleted.
   */
  private async deleteOrphanedComponents(
    board: BoardConfig,
    remainingBoards: BoardConfig[],
    projectDir: string,
    onProgress?: UpdateProgress,
  ): Promise<string[]> {
    const keepPaths = new Set(
      remainingBoards.flatMap((b) => b.components.map((p) => p.replace(/\\/g, '/'))),
    );

    const removed: string[] = [];
    for (const rawPath of board.components) {
      const normalized = rawPath.replace(/\\/g, '/');
      if (!/^components\/.+\.tsx$/.test(normalized)) continue;       // dashboard components only
      if (/AuthProvider|LoginPage|ErrorBoundary/.test(normalized)) continue; // never the shell
      if (keepPaths.has(normalized)) continue;                       // still owned by another board

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
