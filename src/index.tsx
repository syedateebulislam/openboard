#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { existsSync, statSync } from 'node:fs';
import { App } from './App.js';
import { DashboardUpdateService } from './services/project/DashboardUpdateService.js';
import type { DashboardUpdateResult } from './services/project/DashboardUpdateService.js';
import type { PipelineEvent, PipelineEventSink } from './services/project/pipelinePhases.js';
import { TOTAL_STEPS, phaseStep, phaseStepLabel } from './services/project/pipelinePhases.js';
import { classifyAgentError } from './utils/errorCodes.js';
import type { BoardConfig } from './types/board.js';
import type { SetupPartResult } from './services/config/SetupService.js';
import { bannerVersionLine } from './version.js';

const cli = meow(`
  Usage
    $ openboard [command] [options]

  Commands
    start          Launch the OpenBoard TUI
    update         Update dashboards non-interactively
    rollback       Roll a dashboard back to the previous deploy
    agent          Agent automation commands:
                     setup              Headless config (mode|llm|github|vercel|dashboard|billers|status|all)
                     create | onboard   Create dashboard from a data file
                     update             Update a dashboard with a prompt
                     update --all       Modify every dashboard with one prompt
                     remove --all       Remove every dashboard (empty the app)
                     list               List registered dashboards
                     status             Show one dashboard's status
                     runs               List recent pipeline runs
                     resume <run-id>    Resume a failed run
                     rollback           Roll back to the previous deploy

  Options
    --dashboard         Dashboard id, name, or title
    --all               Target all dashboards (regen; with --prompt: modify all; with agent remove: remove all)
    --data              Data source file: .csv, .xlsx, or .json
    --name              Dashboard display name for creation
    --type              Dashboard type: health, finance, grocery, travel, food,
                        shopping, subscriptions, utilities, invoices, custom
    --prompt            User prompt for initial generation or dashboard update
    --mode              App mode (agent setup): local (Ollama/LM Studio + local preview),
                        hybrid (cloud LLM + local preview), remote (cloud LLM +
                        GitHub + live Vercel web app)
    --effort            LLM execution effort: low, medium, high, max (agent setup)
    --base-url          LM Studio API URL (default http://127.0.0.1:1234/v1)
    --scripts-dir           Folder holding your fetch_<biller>.py scripts (agent setup billers)
    --biller-email          Gmail address the fetchers log in as
    --biller-app-password   Gmail App Password (or OPENBOARD_BILLER_APP_PASSWORD)
    --biller-key            Enable this biller; repeatable, replaces the current selection
    --biller-sync-interval  Invoice fetch interval in minutes (default 360)
    --biller-since-days     How far back each fetcher searches (default 30)
    --biller                Run only this biller (agent billers sync)
    --json              Emit machine-readable JSON (NDJSON progress on stderr)
    --dry-run           Parse + analyze and return the plan; no LLM call, no deploy
    --idempotency-key   Reuse the result of a prior succeeded create with this key
    --version, -v       Show version number
    --help, -h          Show this help message

  Examples
    $ openboard
    $ openboard update --dashboard uber-data
    $ openboard update --all
    $ openboard agent setup mode --mode local
    $ openboard agent setup all --mode remote --provider openai --api-key sk-... --github-token ghp_... --vercel-token ... --username admin --password secret123
    $ openboard agent setup all --mode local --provider ollama --username admin --password secret123
    $ openboard agent setup status --json
    $ openboard agent create --data ./data/uber.csv --name "Uber Data" --json
    $ openboard agent update --dashboard uber-data --prompt "Add a monthly trend chart"
    $ openboard agent update --all --prompt "Add a dark footer with a data refresh time"
    $ openboard agent remove --all --json
    $ openboard agent list --json
    $ openboard agent resume run-2026-06-10-ab12cd34 --json
    $ openboard rollback --dashboard uber-data
    $ openboard agent setup billers --scripts-dir ./scripts/invoice_fetchers --biller-email you@gmail.com --biller-app-password "abcd efgh ijkl mnop"
    $ openboard agent billers status --json
    $ openboard agent billers sync --biller zomato --json
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
    quality: {
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
    provider: {
      type: 'string',
    },
    mode: {
      type: 'string',
    },
    model: {
      type: 'string',
    },
    effort: {
      type: 'string',
    },
    apiKey: {
      type: 'string',
    },
    ollamaHost: {
      type: 'string',
    },
    baseUrl: {
      type: 'string',
    },
    githubToken: {
      type: 'string',
    },
    vercelToken: {
      type: 'string',
    },
    codexAccessToken: {
      type: 'string',
    },
    username: {
      type: 'string',
    },
    password: {
      type: 'string',
    },
    scriptsDir: {
      type: 'string',
    },
    billerEmail: {
      type: 'string',
    },
    billerAppPassword: {
      type: 'string',
    },
    billerSyncInterval: {
      type: 'number',
    },
    billerSinceDays: {
      type: 'number',
    },
    billerKey: {
      type: 'string',
      isMultiple: true,
    },
    biller: {
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
  console.log(`${B}${F}║${S}${bannerVersionLine()}${F}║${R}`);
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
 *  - JSON mode: structured NDJSON events on stderr ({"event":"phase"|"log"|"result",
 *    "step":N,"totalSteps":8,...}) so orchestrators can track phase + percent
 *    and detect wedged phases.
 *  - Plain mode: human-readable "[step/total]" labelled lines on stdout, also
 *    derived from the structured events so an agent watching stdout always
 *    sees which step is running and how far along the pipeline is.
 */
const pipelineSink: PipelineEventSink = jsonMode
  ? (event: PipelineEvent) => console.error(JSON.stringify(event))
  : (event: PipelineEvent) => {
      if (event.event === 'phase' && event.phase) {
        const pct = typeof event.pct === 'number' ? ` (${event.pct}%)` : '';
        console.log(`\n${phaseStepLabel(event.phase)}${pct}`);
      } else if (event.event === 'log' && event.message !== undefined) {
        const prefix = event.phase ? `[${phaseStep(event.phase)}/${TOTAL_STEPS}] ` : '';
        console.log(`${prefix}${event.message}`);
      } else if (event.event === 'result') {
        console.log(event.success
          ? '\n✓ Pipeline completed.'
          : `\n✗ Pipeline failed${event.message ? `: ${event.message}` : ''}`);
      }
    };
// Pipeline progress flows through the structured sink in BOTH modes now; the
// legacy line callback stays undefined so lines are never printed twice.
const lineProgress = undefined;

function makeService(): DashboardUpdateService {
  return new DashboardUpdateService(undefined, undefined, undefined, undefined, pipelineSink);
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

function boardStatus(board: BoardConfig) {
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
  const onProgress = lineProgress; // progress flows through the pipeline sink

  if (cli.flags.all && cli.flags.prompt) {
    // Apply one prompt to every dashboard, deploy the shared workspace once.
    const result = await service.updateAllWithPrompt(cli.flags.prompt, onProgress, cli.flags.data);
    if (jsonMode) {
      printJson(result.success ? successPayload('update-all', result) : failurePayload('update-all', result));
      process.exit(result.success ? 0 : 1);
    }
    if (!result.success) {
      console.error(`Modify-all failed: ${result.error}`);
      process.exit(1);
    }
    console.log('Modified all dashboards.');
    if (result.deployUrl) console.log(`Deployment: ${result.deployUrl}`);
    process.exit(0);
  }

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
  const onProgress = lineProgress; // progress flows through the pipeline sink

  if (action === 'setup') {
    const { SetupService } = await import('./services/config/SetupService.js');
    const setup = new SetupService();
    const target = (cli.input[2] ?? 'all').toLowerCase();

    // Secrets: flag first, then env fallback (env is preferred — flags can
    // appear in process listings / shell history).
    const apiKey = cli.flags.apiKey ?? process.env.OPENBOARD_LLM_API_KEY;
    const githubToken = cli.flags.githubToken ?? process.env.OPENBOARD_GITHUB_TOKEN;
    const vercelToken = cli.flags.vercelToken ?? process.env.OPENBOARD_VERCEL_TOKEN;
    const codexAccessToken = cli.flags.codexAccessToken ?? process.env.OPENBOARD_CODEX_ACCESS_TOKEN;
    const password = cli.flags.password ?? process.env.OPENBOARD_DASHBOARD_PASSWORD;
    const billerInput = {
      scriptsDir: cli.flags.scriptsDir,
      email: cli.flags.billerEmail,
      appPassword: cli.flags.billerAppPassword ?? process.env.OPENBOARD_BILLER_APP_PASSWORD,
      syncIntervalMinutes: cli.flags.billerSyncInterval,
      sinceDays: cli.flags.billerSinceDays,
      enable: cli.flags.billerKey?.length ? cli.flags.billerKey : undefined,
    };

    // Login progress (codex device-auth URL/code) streams to stderr so it never
    // corrupts the JSON result on stdout — agents read it as NDJSON-ish lines.
    const setupProgress = (line: string) => console.error(line);
    const llmInput = {
      provider: cli.flags.provider,
      model: cli.flags.model,
      effort: cli.flags.effort,
      apiKey,
      ollamaHost: cli.flags.ollamaHost,
      baseUrl: cli.flags.baseUrl,
      codexAccessToken,
      onProgress: setupProgress,
    };

    const report = (results: Record<string, unknown>) => {
      const ok = Object.values(results).every((r) => (r as { configured?: boolean }).configured !== false);
      if (jsonMode) {
        printJson({ success: ok, action: 'setup', target, results, status: setup.status() });
      } else {
        for (const [part, r] of Object.entries(results)) {
          const res = r as SetupPartResult;
          console.log(res.configured ? `✓ ${part}: ${res.detail ?? 'configured'}` : `✗ ${part}: ${res.error}`);
        }
      }
      process.exit(ok ? 0 : 1);
    };

    if (target === 'status') {
      const status = setup.status();
      if (jsonMode) printJson({ success: true, action: 'setup', target: 'status', status });
      else {
        console.log(`Mode: ${status.modeDescription}`);
        console.log(`LLM: ${status.llm ? `${status.llm.provider} (${status.llm.model ?? 'default'}, effort: ${status.llm.effort ?? 'medium'})` : 'not configured'}`);
        if (status.mode === 'remote') {
          console.log(`GitHub: ${status.github ? status.github.username ?? 'configured' : 'not configured'}`);
          console.log(`Vercel: ${status.vercel ? 'configured' : 'not configured'}`);
        } else {
          console.log('GitHub/Vercel: not used in this mode (local preview only)');
        }
        console.log(`Dashboard login: ${status.dashboardAuth ? 'configured' : 'not configured'}`);
        console.log(`Invoice fetchers: ${status.billers
          ? `${status.billers.ready ? 'ready' : 'incomplete'} — ${status.billers.enabled.length} biller(s) enabled`
          : 'not configured'}`);
      }
      process.exit(0);
    }

    if (target === 'mode') {
      report({ mode: setup.configureMode(cli.flags.mode) });
    } else if (target === 'llm') {
      report({ llm: await setup.configureLLM(llmInput) });
    } else if (target === 'github') {
      report({ github: await setup.configureGitHub(githubToken) });
    } else if (target === 'vercel') {
      report({ vercel: await setup.configureVercel(vercelToken) });
    } else if (target === 'dashboard' || target === 'dashboard-auth') {
      report({ dashboard: await setup.configureDashboardAuth(cli.flags.username, password) });
    } else if (target === 'billers') {
      report({ billers: setup.configureBillers(billerInput) });
    } else if (target === 'all') {
      // Configure whatever inputs were supplied; skip parts with no input.
      // Mode is applied first so provider/GitHub/Vercel validation matches it.
      const results: Record<string, SetupPartResult> = {};
      if (cli.flags.mode) results.mode = setup.configureMode(cli.flags.mode);
      if (cli.flags.provider) results.llm = await setup.configureLLM(llmInput);
      if (githubToken) results.github = await setup.configureGitHub(githubToken);
      if (vercelToken) results.vercel = await setup.configureVercel(vercelToken);
      if (cli.flags.username || password) results.dashboard = await setup.configureDashboardAuth(cli.flags.username, password);
      if (billerInput.scriptsDir || billerInput.email || billerInput.appPassword) {
        results.billers = setup.configureBillers(billerInput);
      }
      if (Object.keys(results).length === 0) {
        const error = 'Nothing to configure. Pass --mode, --provider, --github-token, --vercel-token, --scripts-dir/--biller-email/--biller-app-password, and/or --username/--password (or the matching OPENBOARD_* env vars).';
        if (jsonMode) printJson({ success: false, action: 'setup', target: 'all', error, errorCode: 'E_VALIDATION' });
        else console.error(error);
        process.exit(1);
      }
      report(results);
    } else {
      const error = `Unknown setup target "${target}". Use: mode | llm | github | vercel | dashboard | billers | status | all.`;
      if (jsonMode) printJson({ success: false, action: 'setup', target, error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }
  }

  if (action === 'create' || action === 'onboard') {
    const dataFile = cli.flags.data;
    if (!dataFile) {
      const error = 'Missing required --data <csv|xlsx|json> for agent create.';
      if (jsonMode) printJson({ success: false, action: 'create', error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }

    // Leave type undefined when --type is omitted so the create flow can pick
    // the distinct "agent default" prompt instead of silently using 'custom'.
    const validTypes = ['health', 'finance', 'grocery', 'travel', 'food', 'shopping', 'subscriptions', 'utilities', 'invoices', 'custom'];
    const type = cli.flags.type as BoardConfig['type'] | undefined;
    if (type !== undefined && !validTypes.includes(type)) {
      const error = `Invalid --type. Use one of: ${validTypes.join(', ')}.`;
      if (jsonMode) printJson({ success: false, action: 'create', error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }

    const quality = cli.flags.quality as BoardConfig['uiQuality'] | undefined;
    if (quality !== undefined && quality !== 'high' && quality !== 'low') {
      const error = 'Invalid --quality. Use "high" or "low".';
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
      quality,
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

    if (cli.flags.all) {
      // Modify every dashboard with one prompt, deploy the shared workspace once.
      if (!prompt) {
        const error = 'Missing required --prompt "..." for agent update --all.';
        if (jsonMode) printJson({ success: false, action: 'update-all', error, errorCode: 'E_VALIDATION' });
        else console.error(error);
        process.exit(1);
      }
      const allResult = await service.updateAllWithPrompt(prompt, onProgress, cli.flags.data);
      if (!allResult.success) {
        if (jsonMode) printJson(failurePayload('update-all', allResult));
        else console.error(`Agent modify-all failed: ${allResult.error}`);
        process.exit(1);
      }
      if (jsonMode) printJson(successPayload('update-all', allResult));
      else {
        console.log('Modified all dashboards.');
        if (allResult.deployUrl) console.log(`Deployment: ${allResult.deployUrl}`);
      }
      process.exit(0);
    }

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

  if (action === 'remove') {
    if (!cli.flags.all) {
      const error = 'Missing required --all for agent remove (removes every dashboard).';
      if (jsonMode) printJson({ success: false, action: 'remove-all', error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }
    const removeResult = await service.removeAllDashboards(onProgress);
    if (!removeResult.success) {
      if (jsonMode) printJson(failurePayload('remove-all', removeResult));
      else console.error(`Agent remove-all failed: ${removeResult.error}`);
      process.exit(1);
    }
    if (jsonMode) printJson(successPayload('remove-all', removeResult));
    else {
      console.log('Removed all dashboards. The generated app now shows the empty OpenBoard shell.');
      if (removeResult.deployUrl) console.log(`Deployment: ${removeResult.deployUrl}`);
    }
    process.exit(0);
  }

  if (action === 'list') {
    const boards = service.listBoards();
    if (jsonMode) {
      printJson({
        success: true,
        action: 'list',
        dashboards: boards.map((board) => boardStatus(board)),
      });
    } else {
      if (boards.length === 0) {
        console.log('No dashboards registered.');
      }
      for (const board of boards) {
        const status = boardStatus(board);
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
    const status = boardStatus(board);
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

  if (action === 'billers') {
    const sub = (cli.input[2] ?? 'status').toLowerCase();
    const { TypedConfigRepository } = await import('./services/config/TypedConfigRepository.js');
    const { BillerFetcherService } = await import('./services/billers/BillerFetcherService.js');
    const { recordBillerRun, shouldAnchorRun } = await import('./services/billers/billerScheduler.js');
    const settings = new TypedConfigRepository().getBillerSettings();
    const fetcher = new BillerFetcherService();

    if (!settings.scriptsDir) {
      const error = 'Invoice fetchers are not configured. Run `openboard agent setup billers --scripts-dir "..." --biller-email "..." --biller-app-password "..."`.';
      if (jsonMode) printJson({ success: false, action: `billers-${sub}`, error, errorCode: 'E_VALIDATION' });
      else console.error(error);
      process.exit(1);
    }

    const discovered = fetcher.list();

    if (sub === 'status') {
      const payload = {
        success: true,
        action: 'billers-status',
        scriptsDir: settings.scriptsDir,
        email: settings.email,
        ready: Boolean(settings.email && settings.appPassword),
        syncIntervalMinutes: settings.syncIntervalMinutes,
        lastRunAt: settings.lastRunAt,
        billers: discovered.map((biller) => ({
          key: biller.key,
          displayName: biller.displayName,
          enabled: settings.enabledKeys.includes(biller.key),
          csvPath: biller.csvPath,
        })),
      };
      if (jsonMode) printJson(payload);
      else {
        console.log(`Scripts folder: ${settings.scriptsDir}`);
        console.log(`Gmail account: ${settings.email ?? 'not set'}${settings.appPassword ? '' : ' (App Password missing)'}`);
        console.log(`Interval: every ${settings.syncIntervalMinutes} min · Last run: ${settings.lastRunAt ?? 'never'}`);
        for (const biller of payload.billers) {
          console.log(`  ${biller.enabled ? '[x]' : '[ ]'} ${biller.key.padEnd(18)} ${biller.displayName}`);
        }
      }
      process.exit(0);
    }

    if (sub === 'sync') {
      if (!settings.email || !settings.appPassword) {
        const error = 'Gmail address and App Password are required. Run `openboard agent setup billers --biller-email "..." --biller-app-password "..."`.';
        if (jsonMode) printJson({ success: false, action: 'billers-sync', error, errorCode: 'E_VALIDATION' });
        else console.error(error);
        process.exit(1);
      }
      const only = cli.flags.biller;
      if (only && !discovered.some((biller) => biller.key === only)) {
        const error = `Unknown biller "${only}". Known: ${discovered.map((b) => b.key).join(', ') || 'none'}.`;
        if (jsonMode) printJson({ success: false, action: 'billers-sync', error, errorCode: 'E_VALIDATION' });
        else console.error(error);
        process.exit(1);
      }

      const results = await fetcher.syncEnabled({ onProgress, only });
      if (results.skipped === 'locked') {
        if (jsonMode) printJson({ success: false, action: 'billers-sync', error: 'Another invoice fetch is already running.', errorCode: 'E_LOCKED' });
        else console.error('Another invoice fetch is already running. Retry after it finishes.');
        process.exit(1);
      }
      // Re-anchor the in-TUI schedule: a CLI sync is a real run, and leaving
      // lastRunAt stale would make the next TUI launch fetch everything again.
      // A run that matched no biller is not a run, and must not move the anchor.
      if (shouldAnchorRun(results)) recordBillerRun();
      const ok = results.every((result) => result.ok);
      if (jsonMode) printJson({ success: ok, action: 'billers-sync', results });
      else {
        if (results.length === 0) {
          // Nothing ran for two very different reasons — say which.
          console.log(discovered.length === 0
            ? `No biller scripts found in ${settings.scriptsDir}. Check the folder still exists and holds fetch_<biller>.py files.`
            : 'No billers are enabled. Enable one with `openboard agent setup billers --biller-key <key>`.');
        }
        for (const result of results) {
          if (!result.ok) {
            console.log(`${result.displayName}: FAILED — ${result.error}`);
            continue;
          }
          const change = result.changed ? 'new invoices' : 'no new invoices';
          // "no new invoices" alone reads as healthy even when the biller has
          // no dashboard at all, which is the state a user reads as "nothing
          // happened". Say which of the two it is.
          const dashboard = result.dashboardUpdated
            ? ' — dashboard refreshed'
            : result.dashboardExists === false
              ? ' — no dashboard yet'
              : '';
          console.log(`${result.displayName}: ${change}${dashboard}`);
        }
      }
      process.exit(ok ? 0 : 1);
    }

    const error = `Unknown billers action "${sub}". Use: openboard agent billers <sync|status>.`;
    if (jsonMode) printJson({ success: false, action: 'billers', error, errorCode: 'E_VALIDATION' });
    else console.error(error);
    process.exit(1);
  }

  const error = 'Unknown agent action.';
  if (jsonMode) {
    printJson({ success: false, action: action ?? null, error, errorCode: 'E_VALIDATION' });
  } else {
    console.error('Unknown agent action. Use: openboard agent setup <llm|github|vercel|dashboard|billers|status|all> [flags]');
    console.error('Or: openboard agent create --data <file> [--name "..."] [--prompt "..."]');
    console.error('Or: openboard agent update --dashboard <selector> --prompt "..." [--data <file>]');
    console.error('Or: openboard agent update --all --prompt "..."   (modify every dashboard)');
    console.error('Or: openboard agent remove --all                  (remove every dashboard)');
    console.error('Or: openboard agent list | status | runs | resume <run-id> | rollback');
    console.error('Or: openboard agent billers <sync|status> [--biller <key>]');
  }
  process.exit(1);
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "openboard --help" to see available commands.');
  process.exit(1);
}
