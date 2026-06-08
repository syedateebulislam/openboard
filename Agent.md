# Agent Automation Contract

This file is for automation agents, scheduled jobs, and cron-style tools that need to create or update OpenBoard dashboards without opening the interactive TUI.

OpenBoard owns the complete workflow:

```text
agent command
  -> parse CSV/JSON
  -> analyze fields and rows
  -> call configured internal LLM
  -> write generated React files
  -> record prompt history
  -> build
  -> push to GitHub
  -> deploy to Vercel, or rely on Vercel Git integration after push
```

## Prerequisites

OpenBoard must be configured once by a human:

- LLM provider: OpenAI API key, OpenAI Codex login, Anthropic, Moonshot, or Ollama.
- GitHub token or authenticated GitHub CLI.
- Vercel token or Vercel Git integration.
- Dashboard login credentials.

Install from npm (the package is `openboard-cli`; the installed command is `openboard`):

```bash
npm install -g openboard-cli
```

Check installation:

```bash
node --version
git --version
openboard --version
```

From source, use `node dist/index.js` instead of `openboard` after building:

```bash
npm install
npm run build
node dist/index.js --help
```

## Create Dashboard

Use this when the agent has a new CSV/JSON data source and wants OpenBoard to add a new tab to the shared dashboard app.

```bash
openboard agent create --data "<csv-or-json-path>" --name "<dashboard title>"
```

Full form:

```bash
openboard agent create \
  --data "./data/uber_rides.csv" \
  --name "Uber Rides" \
  --type custom \
  --prompt "Create an operations dashboard with trip volume, fare trends, distance trends, and pickup location breakdowns."
```

PowerShell:

```powershell
openboard agent create --data ".\data\uber_rides.csv" --name "Uber Rides" --type custom --prompt "Create an operations dashboard with trip volume, fare trends, distance trends, and pickup location breakdowns."
```

`onboard` is an alias for `create`:

```bash
openboard agent onboard --data "./data/uber_rides.csv" --name "Uber Rides"
```

Flags:

| Flag | Required | Meaning |
|---|---:|---|
| `--data` | yes | CSV/JSON file path |
| `--name` | no | Dashboard title; derived from file name if omitted |
| `--type` | no | `health`, `finance`, `grocery`, or `custom`; default `custom` |
| `--prompt` | no | Intent for the initial dashboard |
| `--json` | no | Final result as JSON on stdout; progress logs on stderr |

Success output includes:

```text
Created dashboard: Uber Rides
Dashboard selector: uber-rides
Deployment: https://...
```

Save the dashboard selector for later updates.

## Update Dashboard With Prompt

Use this when an agent has a user request for an existing dashboard.

```bash
openboard agent update --dashboard "<selector>" --prompt "<user request>"
```

Example:

```bash
openboard agent update --dashboard "uber-rides" --prompt "Add a weekday vs weekend chart and highlight unusually expensive rides."
```

Use a refreshed data file for this update:

```bash
openboard agent update --dashboard "uber-rides" --data "./latest/uber_rides.csv" --prompt "Refresh all metrics and add a city breakdown."
```

Flags:

| Flag | Required | Meaning |
|---|---:|---|
| `--dashboard` | yes | Dashboard id, slug/name, or exact title |
| `--prompt` | yes | User instruction for UI/code changes |
| `--data` | no | Override the dashboard's linked data file for this run |
| `--json` | no | Final result as JSON on stdout; progress logs on stderr |

## Refresh From Saved Prompt History

Use this when the data source file has changed and the same dashboard intent should be regenerated without a new user prompt.

```bash
openboard update --dashboard "<selector>"
```

Refresh all registered dashboards:

```bash
openboard update --all
```

This relies on local prompt history stored per dashboard. It works after a dashboard has had at least one successful initial generation or prompt update.

## JSON Mode

Use `--json` for reliable machine parsing.

```bash
openboard agent create --data "./data/uber_rides.csv" --name "Uber Rides" --json
openboard agent update --dashboard "uber-rides" --prompt "Add trend charts" --json
```

Success shape:

```json
{
  "success": true,
  "action": "update",
  "dashboard": "Uber Rides",
  "dashboardSelector": "uber-rides",
  "projectDir": "projects/openboard-app-workspace-...",
  "deployUrl": "https://example.vercel.app",
  "writtenFiles": ["App.tsx", "components/UberRidesDashboard.tsx"]
}
```

Failure shape:

```json
{
  "success": false,
  "action": "update",
  "dashboardSelector": "uber-rides",
  "error": "Dashboard not found: uber-rides",
  "writtenFiles": []
}
```

## Exit Codes

| Exit code | Meaning |
|---:|---|
| `0` | Command completed successfully |
| non-zero | Command failed; read stderr/stdout |

Common failures:

```text
Missing required --data <csv|json> for agent create.
Missing required --dashboard <id|name|title> for agent update.
Missing required --prompt "..." for agent update.
Agent update failed: Dashboard not found: <selector>
Agent create failed: File not found: <path>
Agent create failed: No LLM provider configured. Configure LLM settings first.
```

## File Rules

Agents should not edit OpenBoard config, prompt-history, or generated app files directly unless explicitly asked.

OpenBoard stores:

```text
~/.openboard/config.json
~/.openboard/prompt-history/<dashboard-id>.json
projects/openboard-app-workspace-<id>/
```

Always quote Windows paths:

```bash
openboard agent create --data "C:\Users\user\data\uber_rides.csv" --name "Uber Rides"
```

Do not prefix paths with `- `. Pass the raw path only.

## Agent Decision Rules

Use `openboard agent create` when:

- The user provides a new data file.
- There is no existing dashboard selector.
- A new tab should be added to the shared OpenBoard UI.

Use `openboard agent update` when:

- The user wants a UI change for an existing dashboard.
- The user provides a prompt, chart change, metric change, or refreshed data plus a new instruction.

Use `openboard update --dashboard` when:

- The data file changed.
- No new prompt is needed.
- The saved prompt history should drive regeneration.

Use `openboard update --all` when:

- Scheduled jobs refreshed multiple data files.
- All registered dashboards should be rebuilt/deployed.

Do not call `openboard` or `openboard start` from automation. Those start the interactive TUI.

## Smoke Tests

```bash
npm run lint
npm run build
node dist/index.js --help
node dist/index.js agent create
node dist/index.js agent update --dashboard test-dashboard
node dist/index.js agent update --dashboard definitely-missing --prompt "test prompt"
```

Expected validation errors:

```text
Missing required --data <csv|json> for agent create.
Missing required --prompt "..." for agent update.
Agent update failed: Dashboard not found: definitely-missing
```
