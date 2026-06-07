/**
 * Board preset definitions for OpenBoard.
 * Each preset provides a domain-specific starting configuration:
 * default LLM prompt, data column hints, and UI metadata.
 */
export interface BoardPreset {
  id: string;
  name: string;
  icon: string;
  description: string;
  defaultPrompt: string;
  dataHints: string[];
}

export const BOARD_PRESETS: BoardPreset[] = [
  {
    id: 'health',
    name: 'Health',
    icon: '❤️',
    description: 'Apple Health, Fitbit, Garmin data analysis',
    defaultPrompt:
      'Create a health dashboard showing daily steps trends, heart rate patterns, sleep quality, and calorie tracking. Include time-series charts and weekly summaries.',
    dataHints: ['steps', 'heart_rate', 'sleep_hours', 'calories', 'weight', 'date'],
  },
  {
    id: 'finance',
    name: 'Finance',
    icon: '💰',
    description: 'Bank transactions, spending categories, budget tracking',
    defaultPrompt:
      'Create a finance dashboard showing spending trends by category, income vs expenses, monthly comparison, and top spending categories with pie chart breakdown.',
    dataHints: ['date', 'amount', 'category', 'description', 'account', 'type'],
  },
  {
    id: 'grocery',
    name: 'Grocery',
    icon: '🛒',
    description: 'Grocery spending, items, stores, budget tracking',
    defaultPrompt:
      'Create a grocery dashboard showing spending by store, items by category, budget vs actual, and price trends over time.',
    dataHints: ['date', 'store', 'item', 'price', 'quantity', 'category'],
  },
  {
    id: 'custom',
    name: 'Custom',
    icon: '⚙️',
    description: 'Bring your own data and describe what you want',
    defaultPrompt: '',
    dataHints: [],
  },
];

/**
 * Returns a preset by its id, throwing if not found.
 */
export function getPreset(id: string): BoardPreset {
  const preset = BOARD_PRESETS.find(p => p.id === id);
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  return preset;
}

/**
 * Returns all available presets.
 */
export function getAvailablePresets(): BoardPreset[] {
  return BOARD_PRESETS;
}

/**
 * Converts a raw board name into a URL/directory-safe slug.
 * - Lowercases
 * - Strips non-alphanumeric characters (except hyphens/spaces)
 * - Replaces whitespace runs with a single hyphen
 * - Collapses consecutive hyphens
 * - Trims leading/trailing hyphens
 */
export function sanitizeBoardName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Board name is required');
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Creates the board config object from a raw user-provided name.
 * `name` is the slug used for directories/repos; `title` is the display label.
 */
export function createBoardConfig(rawName: string): { name: string; title: string } {
  if (!rawName.trim()) throw new Error('Board name is required');
  return {
    name: sanitizeBoardName(rawName),
    title: rawName.trim(),
  };
}
