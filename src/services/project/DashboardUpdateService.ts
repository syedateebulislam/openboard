import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBoardConfig, getPreset } from '../../config/boardPresets.js';
import { ConfigService } from '../config/ConfigService.js';
import { DataAnalyzer } from '../data/DataAnalyzer.js';
import { DataParserService } from '../data/DataParserService.js';
import { LLMService } from '../llm/LLMService.js';
import { SYSTEM_PROMPT } from '../llm/prompts/systemPrompt.js';
import { TemplateService } from '../template/TemplateService.js';
import { extractFiles } from '../../utils/codeExtractor.js';
import type { BoardConfig } from '../../types/board.js';
import type { LLMConfig } from '../../types/llm.js';
import { BoardRegistryService } from './BoardRegistryService.js';
import { PromptHistoryService } from './PromptHistoryService.js';
import { ProjectManager } from './ProjectManager.js';

export type UpdateProgress = (line: string) => void;

export interface DashboardUpdateResult {
  success: boolean;
  error?: string;
  board?: BoardConfig;
  writtenFiles?: string[];
  deployUrl?: string;
}

export interface CreateDashboardOptions {
  dataFile: string;
  title?: string;
  type?: BoardConfig['type'];
  prompt?: string;
}

export interface PromptUpdateOptions {
  dashboard: string;
  prompt: string;
  dataFile?: string;
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
3. Preserve AuthProvider, LoginPage, useAuth, username display, and logout behavior.
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

  constructor(
    registry = new BoardRegistryService(),
    history = new PromptHistoryService(),
    projectManager = new ProjectManager(),
    templateService = new TemplateService(),
  ) {
    this.registry = registry;
    this.history = history;
    this.projectManager = projectManager;
    this.templateService = templateService;
  }

  listBoards(): BoardConfig[] {
    return this.registry.listBoards();
  }

  findBoard(selector: string): BoardConfig | undefined {
    return this.listBoards().find((board) => matchesBoard(board, selector));
  }

  async createFromDataSource(
    options: CreateDashboardOptions,
    onProgress?: UpdateProgress,
  ): Promise<DashboardUpdateResult> {
    try {
      const dataFile = resolve(options.dataFile);
      const title = options.title?.trim() || titleFromDataFile(dataFile);
      const type = options.type ?? 'custom';
      getPreset(type);

      onProgress?.(`Reading data source: ${dataFile}`);
      const parsed = await DataParserService.parse(dataFile);
      const analysis = DataAnalyzer.analyze(parsed);
      const dataSummary = DataAnalyzer.generateSummary(analysis);
      onProgress?.(`Parsed data source (${analysis.rowCount} rows, ${analysis.columnCount} columns)`);

      const boardName = createBoardConfig(title);
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

      onProgress?.(`Preparing OpenBoard workspace for "${board.title}"...`);
      const scaffold = await this.projectManager.scaffold(board);
      if (!scaffold.success || !scaffold.projectDir) {
        return { success: false, board, error: `Scaffold failed: ${scaffold.error}` };
      }

      const initializedBoard: BoardConfig = {
        ...scaffold.board,
        outputDir: scaffold.projectDir,
        dataSummary,
      };
      await this.writeProtectedData(initializedBoard, parsed, dataSummary, onProgress);

      const writtenFiles = await this.generateAndWriteFiles(
        initializedBoard,
        this.buildInitialPrompt(initializedBoard, dataSummary, options.prompt),
        onProgress,
      );
      if (writtenFiles.length === 0) {
        return { success: false, board: initializedBoard, error: 'LLM did not return any writable files.' };
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

      const deploy = await this.buildPushDeploy(
        updatedBoard,
        writtenFiles,
        `Create ${updatedBoard.name}: ${new Date().toISOString()}`,
        onProgress,
      );
      return deploy;
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async updateByPrompt(
    options: PromptUpdateOptions,
    onProgress?: UpdateProgress,
  ): Promise<DashboardUpdateResult> {
    const board = this.findBoard(options.dashboard);
    if (!board) {
      return { success: false, error: `Dashboard not found: ${options.dashboard}` };
    }
    return this.updateBoardWithPrompt(board, options.prompt, options.dataFile, onProgress);
  }

  async updateBySelector(selector: string, onProgress?: UpdateProgress): Promise<DashboardUpdateResult> {
    const board = this.findBoard(selector);
    if (!board) {
      return {
        success: false,
        error: `Dashboard not found: ${selector}`,
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
    try {
      const projectDir = board.outputDir || this.registry.getSharedProjectDir();
      if (!projectDir) {
        return { success: false, board, error: 'No generated app workspace found.' };
      }

      const dataFile = board.dataFiles[0];
      if (!dataFile) {
        return { success: false, board, error: 'No data source is linked to this dashboard.' };
      }

      const promptHistory = this.history.read(board.id);
      if (promptHistory.length === 0) {
        return {
          success: false,
          board,
          error: 'No prompt history found. Generate or modify this dashboard once before running update.',
        };
      }

      onProgress?.(`Reading latest data: ${dataFile}`);
      const parsed = await DataParserService.parse(dataFile);
      const analysis = DataAnalyzer.analyze(parsed);
      const latestSummary = DataAnalyzer.generateSummary(analysis);
      onProgress?.(`Parsed latest data (${analysis.rowCount} rows, ${analysis.columnCount} columns)`);
      await this.writeProtectedData(board, parsed, latestSummary, onProgress);

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
4. Preserve AuthProvider, LoginPage, useAuth, username display, and logout behavior.
5. Keep the centered master header text exactly "OpenBoard"; do not replace it with "${board.title}".
6. Return all changed files using the required //CODE_START format.`;

      const writtenFiles = await this.generateAndWriteFiles(board, prompt, onProgress);
      if (writtenFiles.length === 0) {
        return { success: false, board, error: 'LLM did not return any writable files.' };
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

      return this.buildPushDeploy(
        updatedBoard,
        writtenFiles,
        `Update ${board.name}: ${new Date().toISOString()}`,
        onProgress,
      );
    } catch (error: any) {
      return { success: false, board, error: error.message };
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
    try {
      const projectDir = board.outputDir || this.registry.getSharedProjectDir();

      // No generated workspace — registry-only removal.
      if (!projectDir) {
        this.registry.removeBoard(board.id);
        onProgress?.('Removed from registry. No generated app workspace was found for UI cleanup.');
        return { success: true, board };
      }

      const remainingBoards = this.registry.listBoards().filter((b) => b.id !== board.id);

      // 1. Clean App.tsx (tab/import/content) via the configured LLM.
      onProgress?.(`Cleaning generated UI for "${board.title}"...`);
      const cleanupMessage = await removeDashboardFromGeneratedApp(board, remainingBoards, projectDir);
      onProgress?.(cleanupMessage);

      // 2. Delete orphaned component files that no remaining dashboard uses.
      const removedFiles = await this.deleteOrphanedComponents(board, remainingBoards, projectDir, onProgress);

      // 3. Delete the dashboard's protected data so the API stops serving it.
      await this.templateService.deleteProtectedDashboardData(projectDir, board.name);
      onProgress?.(`Removed protected data for "${board.name}".`);

      // 4. Code cleanup succeeded — now drop from registry + prompt history.
      this.registry.removeBoard(board.id);

      // 5. Rebuild + push + deploy so the live app no longer shows the dashboard.
      return this.buildPushDeploy(
        { ...board, outputDir: projectDir },
        ['App.tsx', ...removedFiles],
        `Remove ${board.name}: ${new Date().toISOString()}`,
        onProgress,
      );
    } catch (error: any) {
      return { success: false, board, error: error.message };
    }
  }

  async updateBoardWithPrompt(
    board: BoardConfig,
    userPrompt: string,
    dataFileOverride?: string,
    onProgress?: UpdateProgress,
  ): Promise<DashboardUpdateResult> {
    try {
      const projectDir = board.outputDir || this.registry.getSharedProjectDir();
      if (!projectDir) {
        return { success: false, board, error: 'No generated app workspace found.' };
      }
      const dataFile = dataFileOverride ? resolve(dataFileOverride) : board.dataFiles[0];
      if (!dataFile) {
        return { success: false, board, error: 'No data source is linked to this dashboard.' };
      }

      onProgress?.(`Reading latest data: ${dataFile}`);
      const parsed = await DataParserService.parse(dataFile);
      const analysis = DataAnalyzer.analyze(parsed);
      const latestSummary = DataAnalyzer.generateSummary(analysis);
      onProgress?.(`Parsed latest data (${analysis.rowCount} rows, ${analysis.columnCount} columns)`);

      const updatedInputBoard: BoardConfig = {
        ...board,
        outputDir: projectDir,
        dataFiles: [dataFile, ...board.dataFiles.filter((file) => file !== dataFile)],
        dataSummary: latestSummary,
      };
      await this.writeProtectedData(updatedInputBoard, parsed, latestSummary, onProgress);

      const prompt = this.buildPromptUpdatePrompt(updatedInputBoard, latestSummary, userPrompt);
      const writtenFiles = await this.generateAndWriteFiles(updatedInputBoard, prompt, onProgress);
      if (writtenFiles.length === 0) {
        return { success: false, board: updatedInputBoard, error: 'LLM did not return any writable files.' };
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
        dataSummary: latestSummary,
      });

      return this.buildPushDeploy(
        updatedBoard,
        writtenFiles,
        `Update ${updatedBoard.name}: ${new Date().toISOString()}`,
        onProgress,
      );
    } catch (error: any) {
      return { success: false, board, error: error.message };
    }
  }

  private buildInitialPrompt(board: BoardConfig, dataSummary: string, userPrompt?: string): string {
    const currentApp = this.readCurrentApp(board.outputDir);
    const boards = this.registry.listBoards();
    const preset = getPreset(board.type);
    const intent = userPrompt?.trim() || preset.defaultPrompt || 'Create a useful executive analytics dashboard from this dataset.';

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
3. Preserve AuthProvider, LoginPage, useAuth, username display, and logout behavior.
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
3. Preserve AuthProvider, LoginPage, useAuth, username display, and logout behavior.
4. Keep the centered master header text exactly "OpenBoard"; do not replace it with "${board.title}".
5. Load real dashboard rows with useProtectedDashboardData('${board.name}') from src/hooks/useProtectedDashboardData.ts.
6. Do NOT embed raw source rows or sensitive data in App.tsx, component files, or src/data files.
7. Keep the dashboard aligned with the latest data analysis.
8. Return all changed files using the required //CODE_START format.`;
  }

  private async generateAndWriteFiles(
    board: BoardConfig,
    prompt: string,
    onProgress?: UpdateProgress,
  ): Promise<string[]> {
    const llm = LLMService.createProvider(createLLMConfig(new ConfigService()));
    onProgress?.('Generating dashboard code with configured LLM...');
    const response = await llm.complete({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 4096,
    });

    const files = extractFiles(response);
    const projectDir = board.outputDir || this.registry.getSharedProjectDir();
    if (!projectDir || files.length === 0) return [];

    const writtenFiles: string[] = [];
    for (const file of files) {
      await this.templateService.writeGeneratedFile(projectDir, file.path, file.content);
      writtenFiles.push(file.path);
    }
    onProgress?.(`Wrote ${writtenFiles.length} file(s): ${writtenFiles.join(', ')}`);
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

  private async buildPushDeploy(
    board: BoardConfig,
    writtenFiles: string[],
    commitMessage: string,
    onProgress?: UpdateProgress,
  ): Promise<DashboardUpdateResult> {
    const projectDir = board.outputDir || this.registry.getSharedProjectDir();
    if (!projectDir) {
      return { success: false, board, writtenFiles, error: 'No generated app workspace found.' };
    }

    const info = this.projectManager.getProjectInfo(projectDir);
    if (info && !info.hasNodeModules) {
      onProgress?.('Installing dependencies...');
      const installResult = await this.projectManager.install(projectDir, onProgress);
      if (!installResult.success) {
        return { success: false, board, writtenFiles, error: `Install failed: ${installResult.error}` };
      }
    }

    onProgress?.('Building project...');
    const buildResult = await this.projectManager.build(projectDir, onProgress);
    if (!buildResult.success) {
      return { success: false, board, writtenFiles, error: `Build failed: ${buildResult.error}` };
    }
    onProgress?.('Build successful');

    onProgress?.('Pushing to GitHub...');
    const pushResult = await this.projectManager.commitAndPush(projectDir, commitMessage, onProgress);
    const pushedToGitHub = pushResult.success && pushResult.pushed === true;
    if (!pushResult.success) {
      onProgress?.(`GitHub push skipped/failed: ${pushResult.error || 'Unknown error'}`);
      onProgress?.('Continuing with Vercel deployment...');
    }

    onProgress?.('Deploying to Vercel...');
    const deployResult = await this.projectManager.deploy(projectDir, onProgress);
    if (!deployResult.success) {
      if (pushedToGitHub && isVercelAuthError(deployResult.error)) {
        onProgress?.('Pushed to GitHub. Vercel Git integration should deploy this commit automatically.');
        onProgress?.('Direct Vercel CLI deploy was skipped because local Vercel auth is not available.');
        return { success: true, board, writtenFiles };
      }
      return { success: false, board, writtenFiles, error: `Deploy failed: ${deployResult.error}` };
    }

    onProgress?.(`Deployed: ${deployResult.url || 'Success'}`);
    return {
      success: true,
      board,
      writtenFiles,
      deployUrl: deployResult.url,
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
