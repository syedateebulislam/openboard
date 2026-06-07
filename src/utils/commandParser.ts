/**
 * Command Parser — Intercepts special chat commands before they reach the LLM.
 *
 * Supported commands:
 *   /deploy                                      - Full deploy pipeline
 *   /push                                        - Git commit + push only
 *   /preview                                     - Open local dev server
 *   /build                                       - Run TypeScript check + Vite build
 *   /update                                      - Regenerate from latest data + saved prompt history, then deploy
 *   /config                                      - Navigate to settings screen
 *   /status                                      - Show board info + deploy URL
 *   /commands                                    - Show command palette
 *   /doctor                                      - Run local readiness checks
 *   /history                                     - Show dashboard prompt history
 *   /logs                                        - Show latest operation log
 *   /data                                        - Show linked data source summary
 *   /help                                        - Show available commands
 *   /unknown                                     - Show command suggestions
 *   <anything else>                              - Routed to LLM as a message
 */

export type Command =
  | { type: 'deploy' }
  | { type: 'push' }
  | { type: 'preview' }
  | { type: 'build' }
  | { type: 'update' }
  | { type: 'config' }
  | { type: 'status' }
  | { type: 'commands' }
  | { type: 'doctor' }
  | { type: 'history' }
  | { type: 'logs' }
  | { type: 'data' }
  | { type: 'help' }
  | { type: 'unknown'; text: string; suggestions: string[] }
  | { type: 'message'; text: string };

export type ChatCommandCategory = 'local' | 'risky' | 'info' | 'data';

export interface ChatCommandSuggestion {
  command: string;
  description: string;
  category: ChatCommandCategory;
  color: 'cyan' | 'yellow' | 'green' | 'magenta';
}

export const CHAT_COMMANDS: ChatCommandSuggestion[] = [
  { command: '/deploy', category: 'risky', color: 'yellow', description: 'Build, push to GitHub, and deploy to Vercel' },
  { command: '/push', category: 'risky', color: 'yellow', description: 'Commit and push to GitHub only' },
  { command: '/preview', category: 'local', color: 'cyan', description: 'Start or restart local preview' },
  { command: '/build', category: 'local', color: 'cyan', description: 'Run the generated app build' },
  { command: '/update', category: 'data', color: 'magenta', description: 'Refresh from latest data and saved prompt history' },
  { command: '/data', category: 'data', color: 'magenta', description: 'Show linked data file summary' },
  { command: '/history', category: 'data', color: 'magenta', description: 'Show prompt history for this dashboard' },
  { command: '/logs', category: 'info', color: 'green', description: 'Show latest operation log' },
  { command: '/doctor', category: 'info', color: 'green', description: 'Check OpenBoard readiness' },
  { command: '/status', category: 'info', color: 'green', description: 'Show dashboard/project status' },
  { command: '/config', category: 'info', color: 'green', description: 'Open settings' },
  { command: '/commands', category: 'info', color: 'green', description: 'Show command palette' },
  { command: '/help', category: 'info', color: 'green', description: 'Show command help' },
];

/**
 * Parse a user chat input string into a typed Command.
 *
 * - Slash commands for operational actions
 * - Everything else becomes a { type: 'message', text } for the LLM
 */
export function parseCommand(input: string): Command {
  const trimmed = input.trim().toLowerCase();

  if (/^\/deploy$/i.test(trimmed)) return { type: 'deploy' };
  if (/^\/push$/i.test(trimmed)) return { type: 'push' };
  if (/^\/preview$/i.test(trimmed)) return { type: 'preview' };
  if (/^\/build$/i.test(trimmed)) return { type: 'build' };
  if (/^\/update$/i.test(trimmed)) return { type: 'update' };
  if (/^\/data$/i.test(trimmed)) return { type: 'data' };
  if (/^\/history$/i.test(trimmed)) return { type: 'history' };
  if (/^\/logs$/i.test(trimmed)) return { type: 'logs' };
  if (/^\/doctor$/i.test(trimmed)) return { type: 'doctor' };
  if (/^\/commands$/i.test(trimmed)) return { type: 'commands' };
  if (/^\/config$/i.test(trimmed)) return { type: 'config' };
  if (/^\/status$/i.test(trimmed)) return { type: 'status' };
  if (/^\/help$/i.test(trimmed)) return { type: 'help' };

  if (trimmed.startsWith('/')) {
    return {
      type: 'unknown',
      text: input.trim(),
      suggestions: suggestCommands(trimmed),
    };
  }

  return { type: 'message', text: input.trim() };
}

export function suggestCommands(input: string, limit = 4): string[] {
  const normalized = input.trim().toLowerCase();
  if (!normalized.startsWith('/')) return [];
  return CHAT_COMMANDS
    .map((item) => ({
      command: item.command,
      score: commandDistance(normalized, item.command),
    }))
    .sort((a, b) => a.score - b.score || a.command.localeCompare(b.command))
    .slice(0, limit)
    .map((item) => item.command);
}

export function formatUnknownCommandMessage(input: string, suggestions = suggestCommands(input)): string {
  const suggestionText = suggestions.length > 0
    ? `\nDid you mean: ${suggestions.join(', ')}`
    : '';
  return `Unknown command: ${input}${suggestionText}\nType /help to see all commands.`;
}

function commandDistance(a: string, b: string): number {
  const costs = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = costs[0];
    costs[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = costs[j];
      costs[j] = a[i - 1] === b[j - 1]
        ? previous
        : Math.min(previous, costs[j - 1], costs[j]) + 1;
      previous = current;
    }
  }
  return costs[b.length];
}

/**
 * Help text displayed when the user types /help.
 */
export const HELP_TEXT = `Available commands:
  /deploy       - Build + push to GitHub + deploy to Vercel
  /push         - Git commit + push to GitHub only
  /preview      - Start or restart local preview server
  /build        - Run TypeScript check + Vite build
  /update       - Regenerate from latest data using saved prompt history, then build + push + deploy
  /data         - Show linked data source summary
  /history      - Show this dashboard's prompt history
  /logs         - Show latest operation log
  /doctor       - Check LLM/GitHub/Vercel/project readiness
  /config       - Open settings screen
  /status       - Show board info + deploy URL
  /commands     - Show command palette
  /help         - Show this help text
  <message>     - Describe changes to make to your dashboard`;

export const COMMANDS_TEXT = CHAT_COMMANDS
  .map((item) => `${item.command.padEnd(10)} [${item.category}] - ${item.description}`)
  .join('\n');
