Build a polished, mobile-first analytics dashboard tab for this dataset. No dashboard type was specified, so infer the domain and the data's shape entirely from the column names, types, and value patterns in the rows and the data-analysis summary — never assume a fixed schema, and never hardcode any source-specific names.

Data model (OpenBoard):
- This dashboard tab loads its real rows at runtime from `useProtectedDashboardData('<dashboard-name>')`. There is NO file upload — the rows are already parsed and served behind authentication. Derive every metric, chart, and table from that hook's rows.
- Dynamically classify columns: dates/timestamps, numeric measures (amounts, counts, durations, rates), and categorical dimensions (names, types, statuses), and pick the few most meaningful ones to drive the dashboard. Treat values as monetary only when they clearly look like money.
- Normalize rows in a `utils/` helper: parse numbers and dates safely with date-fns, handle missing/null/invalid values, and never throw. Mark a row excluded when it has no usable measure or date, and keep an exclusion reason.

Layout (top to bottom):
- A row of KPI summary cards for the most important aggregate metrics, each with a delta vs the previous period when a date column exists.
- A REQUIRED "Top Insights" block of the top 3 insights (rendered as InsightCard tiles), each with a title, headline metric, one-line detail, and confidence (high/medium/low). If the data is financial/transactional, make these the top 3 SPENDING & SAVINGS insights (tone "spend"/"save"); otherwise the 3 most useful findings: spikes/outliers, top or fastest-growing categories, period-over-period change, concentration. Secondary observations can follow below.
- 2-4 charts (Recharts only, in responsive grids) chosen to fit the data: a trend over time when a date exists, category breakdowns (donut/bar), top-N rankings, and distributions. Every chart needs a title or aria-label and readable axes/legend/tooltip.
- A raw-data table at the bottom using the `.data-table` class: render the hook rows with client-side pagination (page sizes 10/25/50/100), column sorting, and a text search. Sticky header, horizontal scroll on small screens.
- A compact data-quality panel: total rows, included, excluded, missing-value rows, invalid-date rows, and a short note on which columns were auto-detected as measures, dimensions, and dates.

Keep it cohesive with the OpenBoard design system: use the shared utility classes and CSS variables (never hardcoded colors), `var(--chart-N)` for series colors, number/date formatting via Intl and date-fns, and split the work into a main tab component plus small components in `components/` and pure helpers in `utils/`. Do not add new dependencies, do not embed raw rows in source, and do not build any upload UI.
