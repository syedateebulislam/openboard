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
      'Create a polished, mobile-first health dashboard. Top: a row of KPI summary cards (avg daily steps, resting heart rate, avg sleep hours, calories) with trend arrows vs last week. Below: time-series charts for steps, heart rate, and sleep quality with 7-day moving averages, plus a weekly summary heatmap. Add an "Insights" section with 2-3 auto-generated observations (e.g. best/worst sleep days, activity streaks, anomalies). Use a responsive grid that collapses to a single column on small screens, touch-friendly tooltips, soft card shadows, rounded corners, and a calm green/teal palette with dark-mode-friendly colors.',
    dataHints: ['steps', 'heart_rate', 'sleep_hours', 'calories', 'weight', 'date'],
  },
  {
    id: 'finance',
    name: 'Finance',
    icon: '💰',
    description: 'Bank transactions, spending categories, budget tracking',
    defaultPrompt:
      'Create a rich, mobile-first expense tracking dashboard. Top: KPI cards for total spend this month, income vs expenses (net), avg daily spend, and biggest single expense — each with a delta vs previous month. Charts: monthly spending trend line with income overlay, category breakdown as a donut chart with legend, top 5 spending categories bar chart, and a recent-transactions list with category icons. Add a "Spending Insights" panel highlighting unusual spikes, fastest-growing categories, recurring subscriptions detected, and a simple budget health indicator. Use a responsive card grid (1 column on mobile, 2-3 on desktop), large touch targets, currency formatting, color-coded amounts (red expenses, green income), and a clean modern look with subtle shadows and rounded cards.',
    dataHints: ['date', 'amount', 'category', 'description', 'account', 'type'],
  },
  {
    id: 'grocery',
    name: 'Grocery',
    icon: '🛒',
    description: 'Grocery spending, items, stores, budget tracking',
    defaultPrompt:
      'Create an engaging, mobile-first grocery spending dashboard. Top: KPI cards for total grocery spend this month, budget vs actual with a progress bar, avg basket size, and most-visited store. Charts: spending by store (horizontal bars), items by category (donut), weekly spend trend line, and a price-watch table showing items whose unit price rose or fell the most over time. Add an "Insights" section with savings tips: cheapest store per category, items bought most frequently, and projected month-end spend vs budget. Layout must be a responsive grid collapsing to one column on phones, with sticky KPI cards, touch-friendly charts, warm orange/green accents, currency formatting, and clear over/under-budget color coding.',
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
