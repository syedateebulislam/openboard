Build a clean, mobile-first analytics dashboard tab for this dataset. Infer the data's shape from the column names and values and the data-analysis summary; do not assume a fixed schema.

Load the real rows at runtime from `useProtectedDashboardData('<dashboard-name>')` — there is no file upload. Derive everything from those rows, and guard against missing, null, or unparseable fields so the component never throws.

Include: a row of KPI summary cards for the key aggregate metrics (with a delta vs the previous period when a date exists); 2-3 Recharts charts that fit the data (a trend over time, a category breakdown, and a top-N ranking); and a short "Insights" section of 2-3 plain-language observations. Use the OpenBoard design-system utility classes and CSS variables with `var(--chart-N)` series colors (never hardcoded colors), format numbers and dates via Intl and date-fns, and keep every chart labelled. Do not add new dependencies and do not embed raw rows in source.
