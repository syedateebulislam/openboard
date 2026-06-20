/**
 * Prompt builder for Stage 4: React component generation.
 * Each component is generated with a separate LLM call so components remain
 * focused and independently type-checkable.
 */
export function buildComponentGenerationPrompt(
  componentName: string,
  userDescription: string,
  types: string,
  dataExports: string,
  referenceComponent: string,
): string {
  return `Generate a React component named "${componentName}" for a data analytics dashboard.

User request: ${userDescription}

Available TypeScript types:
${types}

Available data imports:
${dataExports}

Reference component pattern:
${referenceComponent}

Requirements:
- Use Recharts for all charts (LineChart, BarChart, PieChart, AreaChart, etc.)
- Use Tailwind CSS for styling
- Import from recharts, lucide-react, date-fns as needed
- Export the component as default
- Make it visually rich with proper labels and tooltips
- Style with the OpenBoard design system so the component works in BOTH dark and light themes: use CSS variables ('var(--chart-1)'..'var(--chart-6)' for series colors, 'var(--chart-grid)' for grid strokes, --text-*/--bg-*/--border for surfaces) and the shared utility classes (.card, .kpi-card, .kpi-label, .kpi-value, .delta-up/.delta-down, .grid-2/.grid-3/.grid-4, .chart-container, .insight-panel, .skeleton). NEVER hardcode hex colors.
- If this component is a dashboard tab/panel, START it with the shared <DashboardHeader title=... rowCount={data?.rows.length} generatedAt={data?.generatedAt} /> from '../components/DashboardHeader' (name left; total rows + last-updated on the right), fed from the protected data hook — do not hand-roll that strip
- Mobile-first: single-column friendly, responsive grid classes, no fixed pixel widths
- Include accessible chart text: a visible title or aria-label, useful axis/legend labels, keyboard-visible focus styles for controls, and do not rely on color alone
- Do not embed raw/private rows in frontend code; consume data passed by props or fetched with the protected OpenBoard data hook when used in the app
Return ONLY the TSX file content.`;
}
