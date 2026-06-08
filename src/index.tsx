#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './App.js';
import { DashboardUpdateService } from './services/project/DashboardUpdateService.js';

const cli = meow(`
  Usage
    $ openboard [command] [options]

  Commands
    start          Launch the OpenBoard TUI
    update         Update dashboards non-interactively
    agent         Agent automation commands

  Options
    --dashboard    Dashboard id, name, or title to update
    --all          Update all registered dashboards
    --data         CSV/JSON data source file
    --name         Dashboard display name for creation
    --type         Dashboard type: health, finance, grocery, custom
    --prompt       User prompt for initial generation or dashboard update
    --json         Emit machine-readable JSON for agent commands
    --version, -v  Show version number
    --help, -h     Show this help message

  Examples
    $ openboard
    $ openboard start
    $ openboard update --dashboard uber-data
    $ openboard update --all
    $ openboard agent create --data ./data/uber.csv --name "Uber Data"
    $ openboard agent update --dashboard uber-data --prompt "Add a monthly trend chart"
    $ openboard --version
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
  console.log(`${B}${F}║${S}                v1.0.0                 ${F}║${R}`);
  console.log(`${B}${F}╚═══════════════════════════════════════╝${R}`);
  process.exit(0);
}

// Handle --help flag (meow handles this automatically, but just in case)
if (cli.flags.help) {
  cli.showHelp(0);
}

const command = cli.input[0];

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
  const service = new DashboardUpdateService();
  const onProgress = (line: string) => console.log(line);

  if (cli.flags.all) {
    const results = await service.updateAll(onProgress);
    const failed = results.filter((result) => !result.success);
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
    console.error(`Update failed: ${result.error}`);
    process.exit(1);
  }

  console.log(`Updated dashboard: ${result.board?.title ?? dashboard}`);
  if (result.deployUrl) {
    console.log(`Deployment: ${result.deployUrl}`);
  }
  process.exit(0);
} else if (command === 'agent') {
  const action = cli.input[1];
  const service = new DashboardUpdateService();
  const jsonMode = Boolean(cli.flags.json);
  const onProgress = (line: string) => {
    if (jsonMode) {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  if (action === 'create' || action === 'onboard') {
    const dataFile = cli.flags.data;
    if (!dataFile) {
      const error = 'Missing required --data <csv|json> for agent create.';
      if (jsonMode) printJson({ success: false, action: 'create', error });
      else console.error(error);
      process.exit(1);
    }

    const type = (cli.flags.type ?? 'custom') as 'health' | 'finance' | 'grocery' | 'custom';
    if (!['health', 'finance', 'grocery', 'custom'].includes(type)) {
      const error = 'Invalid --type. Use one of: health, finance, grocery, custom.';
      if (jsonMode) printJson({ success: false, action: 'create', error });
      else console.error(error);
      process.exit(1);
    }

    const result = await service.createFromDataSource({
      dataFile,
      title: cli.flags.name,
      type,
      prompt: cli.flags.prompt,
    }, onProgress);

    if (!result.success) {
      if (jsonMode) {
        printJson({
          success: false,
          action: 'create',
          error: result.error,
          dashboard: result.board?.title,
          dashboardSelector: result.board?.name,
          projectDir: result.board?.outputDir,
          writtenFiles: result.writtenFiles ?? [],
        });
      } else {
        console.error(`Agent create failed: ${result.error}`);
      }
      process.exit(1);
    }

    if (jsonMode) {
      printJson({
        success: true,
        action: 'create',
        dashboard: result.board?.title,
        dashboardSelector: result.board?.name,
        projectDir: result.board?.outputDir,
        deployUrl: result.deployUrl,
        writtenFiles: result.writtenFiles ?? [],
      });
    } else {
      console.log(`Created dashboard: ${result.board?.title}`);
      console.log(`Dashboard selector: ${result.board?.name}`);
      if (result.deployUrl) {
        console.log(`Deployment: ${result.deployUrl}`);
      }
    }
    process.exit(0);
  }

  if (action === 'update') {
    const dashboard = cli.flags.dashboard;
    const prompt = cli.flags.prompt;
    if (!dashboard) {
      const error = 'Missing required --dashboard <id|name|title> for agent update.';
      if (jsonMode) printJson({ success: false, action: 'update', error });
      else console.error(error);
      process.exit(1);
    }
    if (!prompt) {
      const error = 'Missing required --prompt "..." for agent update.';
      if (jsonMode) printJson({ success: false, action: 'update', dashboardSelector: dashboard, error });
      else console.error(error);
      process.exit(1);
    }

    const result = await service.updateByPrompt({
      dashboard,
      prompt,
      dataFile: cli.flags.data,
    }, onProgress);

    if (!result.success) {
      if (jsonMode) {
        printJson({
          success: false,
          action: 'update',
          dashboard: result.board?.title,
          dashboardSelector: result.board?.name ?? dashboard,
          projectDir: result.board?.outputDir,
          error: result.error,
          writtenFiles: result.writtenFiles ?? [],
        });
      } else {
        console.error(`Agent update failed: ${result.error}`);
      }
      process.exit(1);
    }

    if (jsonMode) {
      printJson({
        success: true,
        action: 'update',
        dashboard: result.board?.title ?? dashboard,
        dashboardSelector: result.board?.name ?? dashboard,
        projectDir: result.board?.outputDir,
        deployUrl: result.deployUrl,
        writtenFiles: result.writtenFiles ?? [],
      });
    } else {
      console.log(`Updated dashboard: ${result.board?.title ?? dashboard}`);
      if (result.deployUrl) {
        console.log(`Deployment: ${result.deployUrl}`);
      }
    }
    process.exit(0);
  }

  const error = 'Unknown agent action.';
  if (jsonMode) {
    printJson({ success: false, action: action ?? null, error });
  } else {
    console.error('Unknown agent action. Use: openboard agent create --data <file> [--name "..."] [--prompt "..."]');
    console.error('Or: openboard agent update --dashboard <selector> --prompt "..." [--data <file>]');
  }
  process.exit(1);
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "openboard --help" to see available commands.');
  process.exit(1);
}
