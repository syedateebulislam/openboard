#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { existsSync, statSync } from 'node:fs';
import { App } from './App.js';
import { DashboardUpdateService } from './services/project/DashboardUpdateService.js';
import type { DashboardUpdateResult } from './services/project/DashboardUpdateService.js';
import type { PipelineEvent, PipelineEventSink } from './services/project/pipelinePhases.js';
import { classifyAgentError } from './utils/errorCodes.js';
import type { BoardConfig } from './types/board.js';

const cli = meow(`
  Usage
    $ openboard [command] [options]

  Commands
    start          Launch the OpenBoard TUI
    update         Update dashboards non-interactively
    rollback       Roll a dashboard back to the previous deploy
    agent          Agent automation commands:
                     create | onboard   Create dashboard from a data file
                     update             Update a dashboard with a prompt
                     list               List registered dashboards
                     status             Show one dashboard's status
                     runs               List recent pipeline runs
                     resume <run-id>    Resume a failed run
                     rollback           Roll back to the previous deploy

  Options
    --dashboard         Dashboard id, name, or title
    --all               Update all registered dashboards
    --data              CSV/JSON data source file
    --name              Dashboard display name for creation
    --type              Dashboard type: health, finance, grocery, custom
    --prompt            User prompt for initial generation or dashboard update
    --json              Emit machine-readable JSON (NDJSON progress on stderr)
    --dry-run           Parse + analyze and return the plan; no LLM call, no deploy
    --idempotency-key   Reuse the result of a prior succeeded create with this key
    --version, -v       Show version number
    --help, -h          Show this help message

  Examples
    $ openboard
    $ openboard update --dashboard uber-data
    $ openboard update --all
    $ openboard agent create --data ./data/uber.csv --name "Uber Data" --json
    $ openboard agent update --dashboard uber-data --prompt "Add a monthly trend chart"
    $ openboard agent list --json
    $ openboard agent resume run-2026-06-10-ab12cd34 --json
    $ openboard rollback --dashboard uber-data
`, {
  importMeta: import.meta,
  autoVersion: false,
  flags: {
    version: {
      type: 'boolean',
      shortFlag: 'v',
    },
    help: {
      type: 'boolean',
      shortFlag: 'h',
    },
    dashboard: {
      type: 'string',
    },
    all: {
      type: 'boolean',
    },
    data: {
      type: 'string',
    },
    name: {
      type: 'string',
    },
    type: {
      type: 'string',
    },
    prompt: {
      type: 'string',
    },
    json: {
      type: 'boolean',
    },
    dryRun: {
      type: 'boolean',
    },
    idempotencyKey: {
      type: 'string',
    },
  },
});

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

// Handle --version flag
if (cli.flags.version) {
  const L = '\x1b[38;2;193;127;83m'; // #C17F53
  const F = '\x1b[38;2;139;115;85m'; // #8B7355
  const S = '\x1b[38;2;220;220;220m'; // #DCDCDC
  const B = '\x1b[1m';
  const R = '\x1b[0m';
  console.log(`${B}${F}╔═══════════════════════════════════════╗${R}`);
  console.log(`${B}${F}║${L}        [_-_] O p e n B o a r d        ${F}║${R}`);
  console.log(`${B}${F}║${S}     Analytics Dashboard Generator     ${F}║${R}`);
  console.log(`${B}${F}║${S}                v1.0.6                 ${F}║${R}`);
  console.log(`${B}${F}╚═══════════════════════════════════════╝${R}`);
  process.exit(0);
}

// Handle --help flag (meow handles this automatically, but just in case)
if (cli.flags.help) {
  cli.showHelp(0);
}

const command = cli.input[0];
const jsonMode = Boolean(cli.flags.json);

/**
 * Progress plumbing:
 *  - JSON mode: structured NDJSON events on stderr ({"event":"phase"|"log"|"result",...})
 *    so orchestrators can track phase + percent and detect wedged phases.
 *  - Plain mode: human-readable lines on stdout.
 */
const ndjsonSink: PipelineEventSink | undefined = jsonMode
  ? (event: PipelineEvent) => console.error(JSON.stringify(event))
  : undefined;
const lineProgress = jsonMode ? undefined : (line: string) => console.log(line);

function makeService(): DashboardUpdateService {
  return new DashboardUpdateService(undefined, undefined, undefined, undefined, ndjsonSink);
}

function failurePayload(action: string, result: DashboardUpdateResult, dashboardSelector?: string) {
  return {
    success: false,
    action,
    dashboard: result.board?.title,
    dashboardSelector: result.board?.name ?? dashboardSelector,
    projectDir: result.board?.outputDir,
    runId: result.runId,
    error: result.error,
    errorCode: result.errorCode ?? classifyAgentError(result.error),
    writtenFiles: result.writtenFiles ?? [],
  };
}

function successPayload(action: string, result: DashboardUpdateResult, dashboardSelector?: string) {
  return {
    success: true,
    action,
    dashboard: result.board?.title ?? dashboardSelector,
    dashboardSelector: result.board?.name ?? dashboardSelector,
    projectDir: result.board?.outputDir,
    deployUrl: result.deployUrl,
    deployTag: result.deployTag,
    verified: result.verified,
    runId: result.runId,
    reused: result.reused,
    plan: result.plan,
    tokenUsage: result.tokenUsage,
    writtenFiles: result.writtenFiles ?? [],
  };
}

function boardStatus(service: DashboardUpdateService, board: BoardConfig) {
  const dataFiles = board.dataFiles.map((file) => {
    let mtime: string | undefined;
    let exists = false;
    try {
      exists = existsSync(file);
      if (exists) mtime = statSync(file).mtime.toISOString();
    } catch {
      // unreadable
    }
    return { path: file, exists, modifiedAt: mtime };
  });
  // Data is stale when any source file changed after the last generation.
  const dataStale = Boolean(
    board.generatedAt &&
    dataFiles.some((file) => file.modifiedAt && file.modifiedAt > board.generatedAt!),
  );
  return {
    id: board.id,
    dashboard: board.title,
    dashboardSelector: board.name,
    type: board.type,
    projectDir: board.outputDir || undefined,
    projectDirExists: board.outputDir ? existsSync(board.outputDir) : false,
    deployUrl: board.deployUrl,
    lastDeployed: board.lastDeployed,
    createdAt: board.createdAt,
    generatedAt: board.generatedAt,
    dataFiles,
    dataStale,
    components: board.components,
  };
}

if (!command || command === 'start') {
  // Check if running in interactive terminal (TTY)
  if (!process.stdin.isTTY) {
    console.error('Error: OpenBoard requires an interactive terminal (TTY).');
    console.error('Please run this command directly in your terminal, not via pipes or redirects.');
    process.exit(1);
  }

  // Render the TUI
  render(React.createElement(App));
} else if (command === 'update') {
  const service = makeService();
  const onProgress = lineProgress ?? ((line: string) => console.error(line));

  if (cli.flags.all) {
    const results = await service.updateAll(onProgress);
    const failed = results.filter((result) => !result.success);
    if (jsonMode) {
      printJson({
        success: failed.length === 0,
        action: 'update-all',
        results: results.map((result) => result.success
          ? successPayload('update', result)
          : failurePayload('update', result)),
      });
      process.exit(failed.length > 0 ? 1 : 0);
    }
    if (failed.length > 0) {
      for (const result of failed) {
        console.error(`Update failed${result.board ? ` for ${result.board.title}` : ''}: ${result.error}`);
      }
      process.exit(1);
    }
    console.log(`Updated ${results.length} dashboard(s).`);
    process.exit(0);
  }

  const dashboard = cli.flags.dashboard;
  if (!dashboard) {
    const boards = service.listBoards();
    console.error('Missing required --dashboard <id|name|title> or --all.');
    if (boards.length > 0) {
      console.error('Registered dashboards:');
      for (const board of boards) {
        console.error(`- ${board.name} (${board.title})`);
      }
    }
    process.exit(1);
  }

  const result = await service.updateBySelector(dashboard, onProgress);
  if (!result.success) {
    if (jsonMode) printJson(failurePayload('update', result, dashboard));
    else console.error(`Update failed: ${result.error}`);
    process.exit(1);
  }

  if (jsonMode) {
    printJson(successPayload('update', result, dashboard));
  } else {
    console.log(`Updated dashboard: ${result.board?.title ?? dashboard}`);
    if (result.deployUrl) {
      console.log(`Deployment: ${result.deployUrl}`);
    }
    if (result.verified === false) {
      console.log('Warning: deployment URL did not pass post-deploy verification.');
    }
  }
  process.exit(0);
} else if (command === 'rollback') {
  const service = makeService();
  const dashboard = cli.flags.dashboard;
  if (!dashboard) {
    const error = 'Missing required --dashboard <id|name|title> for rollback.';
    if (jsonMode) printJson({ success: false, action: 'rollback', error, errorCode: 'E_VALIDATION' });
    else console.error(error);
    process.exit(1);
  }

  const result = await service.rollback(dashboard, lineProgress);
  if (!result.success) {
    if (jsonMode) printJson(failurePayload('rollback', result, dashboard));
    else console.error(`Rollback failed: ${result.error}`);
    process.exit(1);
  }
  if (jsonMode) {
    printJson(successPayload('rollback', result, dashboard));
  } else {
    console.log(`Rolled back dashboard: ${result.board?.title ?? dashboard}`);
    if (result.deployUrl) console.log(`Deployment: ${result.deployUrl}`);
  }
  process.exit(0);
} else if (command === 'agent') {
  const action = cli.input[1];
  const service = makeService();
  const onProgress = jsonMode ? undefined : (line: string) => console.log(line);

  if (action === 'create' || action === 'onboard') {
    const dataFile = cli.flags.data;
    if (!dataFile) {
      const error = 'Missing required --data <csv|json> for agent create.';
      if (jsonMode) printJson({ success: false, action: 'create', error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }

    const type = (cli.flags.type ?? 'custom') as 'health' | 'finance' | 'grocery' | 'custom';
    if (!['health', 'finance', 'grocery', 'custom'].includes(type)) {
      const error = 'Invalid --type. Use one of: health, finance, grocery, custom.';
      if (jsonMode) printJson({ success: false, action: 'create', error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }

    const result = await service.createFromDataSource({
      dataFile,
      title: cli.flags.name,
      type,
      prompt: cli.flags.prompt,
      dryRun: cli.flags.dryRun,
      idempotencyKey: cli.flags.idempotencyKey,
    }, onProgress);

    if (!result.success) {
      if (jsonMode) printJson(failurePayload('create', result));
      else console.error(`Agent create failed: ${result.error}`);
      process.exit(1);
    }

    if (jsonMode) {
      printJson(successPayload('create', result));
    } else if (result.plan) {
      console.log(`Dry run plan for "${result.plan.title}" (${result.plan.selector}):`);
      console.log(`  Type: ${result.plan.type}`);
      console.log(`  Data: ${result.plan.rowCount} rows, ${result.plan.columnCount} columns`);
      console.log('  No LLM call was made and no files were written.');
    } else {
      console.log(`Created dashboard: ${result.board?.title}`);
      console.log(`Dashboard selector: ${result.board?.name}`);
      if (result.deployUrl) {
        console.log(`Deployment: ${result.deployUrl}`);
      }
      if (result.verified === false) {
        console.log('Warning: deployment URL did not pass post-deploy verification.');
      }
      if (result.runId) console.log(`Run id: ${result.runId}`);
    }
    process.exit(0);
  }

  if (action === 'update') {
    const dashboard = cli.flags.dashboard;
    const prompt = cli.flags.prompt;
    if (!dashboard) {
      const error = 'Missing required --dashboard <id|name|title> for agent update.';
      if (jsonMode) printJson({ success: false, action: 'update', error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }
    if (!prompt) {
      const error = 'Missing required --prompt "..." for agent update.';
      if (jsonMode) printJson({ success: false, action: 'update', dashboardSelector: dashboard, error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }

    const result = await service.updateByPrompt({
      dashboard,
      prompt,
      dataFile: cli.flags.data,
      dryRun: cli.flags.dryRun,
    }, onProgress);

    if (!result.success) {
      if (jsonMode) printJson(failurePayload('update', result, dashboard));
      else console.error(`Agent update failed: ${result.error}`);
      process.exit(1);
    }

    if (jsonMode) {
      printJson(successPayload('update', result, dashboard));
    } else if (result.plan) {
      console.log(`Dry run plan for "${result.plan.title}" (${result.plan.selector}):`);
      console.log(`  Data: ${result.plan.rowCount} rows, ${result.plan.columnCount} columns`);
      console.log('  No LLM call was made and no files were written.');
    } else {
      console.log(`Updated dashboard: ${result.board?.title ?? dashboard}`);
      if (result.deployUrl) {
        console.log(`Deployment: ${result.deployUrl}`);
      }
      if (result.verified === false) {
        console.log('Warning: deployment URL did not pass post-deploy verification.');
      }
      if (result.runId) console.log(`Run id: ${result.runId}`);
    }
    process.exit(0);
  }

  if (action === 'list') {
    const boards = service.listBoards();
    if (jsonMode) {
      printJson({
        success: true,
        action: 'list',
        dashboards: boards.map((board) => boardStatus(service, board)),
      });
    } else {
      if (boards.length === 0) {
        console.log('No dashboards registered.');
      }
      for (const board of boards) {
        const status = boardStatus(service, board);
        console.log(`${board.name}  "${board.title}"  ${board.type}${status.dataStale ? '  [data changed since last generation]' : ''}`);
        if (board.deployUrl) console.log(`  ${board.deployUrl}`);
      }
    }
    process.exit(0);
  }

  if (action === 'status') {
    const dashboard = cli.flags.dashboard;
    if (!dashboard) {
      const error = 'Missing required --dashboard <id|name|title> for agent status.';
      if (jsonMode) printJson({ success: false, action: 'status', error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }
    const board = service.findBoard(dashboard);
    if (!board) {
      const error = `Dashboard not found: ${dashboard}`;
      if (jsonMode) printJson({ success: false, action: 'status', dashboardSelector: dashboard, error, errorCode: 'E_DASHBOARD_NOT_FOUND' });
      else console.error(error);
      process.exit(1);
    }
    const status = boardStatus(service, board);
    if (jsonMode) {
      printJson({ success: true, action: 'status', ...status });
    } else {
      console.log(`Dashboard: ${status.dashboard} (${status.dashboardSelector})`);
      console.log(`Type: ${status.type}`);
      console.log(`Generated: ${status.generatedAt ?? 'never'}`);
      console.log(`Deploy URL: ${status.deployUrl ?? 'none recorded'}`);
      console.log(`Data stale: ${status.dataStale ? 'yes — source changed since last generation' : 'no'}`);
      for (const file of status.dataFiles) {
        console.log(`  Data: ${file.path} (${file.exists ? `modified ${file.modifiedAt}` : 'MISSING'})`);
      }
    }
    process.exit(0);
  }

  if (action === 'runs') {
    const runs = service.listRuns(20);
    if (jsonMode) {
      printJson({
        success: true,
        action: 'runs',
        summary: service.runSummary(),
        runs: runs.map((run) => ({
          runId: run.runId,
          action: run.action,
          status: run.status,
          currentPhase: run.currentPhase,
          dashboard: run.boardTitle,
          dashboardSelector: run.boardName,
          createdAt: run.createdAt,
          error: run.error,
          errorCode: run.errorCode,
          tokenUsage: run.tokenUsage,
        })),
      });
    } else {
      if (runs.length === 0) console.log('No recorded runs.');
      for (const run of runs) {
        console.log(`${run.runId}  ${run.action}  ${run.status}${run.currentPhase ? `  [${run.currentPhase}]` : ''}  ${run.boardName ?? ''}`);
        if (run.error) console.log(`  ${run.errorCode ?? ''} ${run.error}`);
      }
    }
    process.exit(0);
  }

  if (action === 'resume') {
    const runId = cli.input[2];
    if (!runId) {
      const error = 'Missing required run id: openboard agent resume <run-id>.';
      if (jsonMode) printJson({ success: false, action: 'resume', error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }
    const result = await service.resume(runId, onProgress);
    if (!result.success) {
      if (jsonMode) printJson(failurePayload('resume', result));
      else console.error(`Agent resume failed: ${result.error}`);
      process.exit(1);
    }
    if (jsonMode) printJson(successPayload('resume', result));
    else {
      console.log(`Resumed run: ${runId}`);
      if (result.deployUrl) console.log(`Deployment: ${result.deployUrl}`);
    }
    process.exit(0);
  }

  if (action === 'rollback') {
    const dashboard = cli.flags.dashboard;
    if (!dashboard) {
      const error = 'Missing required --dashboard <id|name|title> for agent rollback.';
      if (jsonMode) printJson({ success: false, action: 'rollback', error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }
    const result = await service.rollback(dashboard, onProgress);
    if (!result.success) {
      if (jsonMode) printJson(failurePayload('rollback', result, dashboard));
      else console.error(`Agent rollback failed: ${result.error}`);
      process.exit(1);
    }
    if (jsonMode) printJson(successPayload('rollback', result, dashboard));
    else {
      console.log(`Rolled back dashboard: ${result.board?.title ?? dashboard}`);
      if (result.deployUrl) console.log(`Deployment: ${result.deployUrl}`);
    }
    process.exit(0);
  }

  const error = 'Unknown agent action.';
  if (jsonMode) {
    printJson({ success: false, action: action ?? null, error, errorCode: 'E_VALIDATION' });
  } else {
    console.error('Unknown agent action. Use: openboard agent create --data <file> [--name "..."] [--prompt "..."]');
    console.error('Or: openboard agent update --dashboard <selector> --prompt "..." [--data <file>]');
    console.error('Or: openboard agent list | status | runs | resume <run-id> | rollback');
  }
  process.exit(1);
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "openboard --help" to see available commands.');
  process.exit(1);
}
