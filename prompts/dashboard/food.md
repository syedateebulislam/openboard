Build an engaging, mobile-first food & dining dashboard tab for this dataset that works for any delivery or restaurant export (Swiggy, Zomato, Instamart, UberEats, or similar) — never hardcode an app's schema; infer the useful fields dynamically from the column names and value patterns in the data.

Data model (OpenBoardCLI):
- This dashboard tab loads its real rows at runtime from `useProtectedDashboardData('<dashboard-name>')`. There is NO file upload — derive every metric, chart, and table from that hook's rows.
- Dynamically detect the meaningful columns, case-insensitively: order date (order_date/ordered_at/delivered_at/document_date/email_date — prefer the actual order date), paid amount (total_paid/grand_total/amount — prefer the final paid amount), restaurant/merchant/store, items/description, delivery/platform/packaging fees, discount, taxes, payment method, currency.
- Normalize rows in a `utils/` helper: parse amounts safely, parse dates with date-fns across common formats, never throw on bad input. Mark a row excluded when no valid amount or date is found, and keep an exclusion reason.

Layout (top to bottom):
- Choose 3-6 non-redundant KPIs from supported candidates such as tracked spend, order count, typical order value, restaurant concentration, observed fees/discounts, and coverage. Show deltas only for complete comparable periods.
- Apply the evidence-first Top Insights contract from the system prompt. Candidate questions include restaurant concentration, observed fee share, repeat-order price changes, time-of-day patterns, discounts actually captured, and material order anomalies. Require enough comparable orders for any trend or "cheapest" claim; never assume that skipping fees, changing restaurants, or ordering at another time would save money unless the rows provide a measured comparison.
- Choose 1-4 Recharts views from supported candidates such as a period trend, restaurant ranking, weekday/time pattern, or observed fee-versus-food comparison. Include a period trend only when the date span supports it; omit any view whose source fields are sparse or degenerate.
- Chart hygiene: explicit Recharts margin on every chart; horizontal bars need a fixed YAxis width (~140) with an ellipsis tickFormatter; cap dense time-axis ticks; format axis numbers compactly (12.4k); never render a pie/donut for a dimension with fewer than 2 meaningful values.
- Usually include a compact recent-orders table when record inspection is useful, newest first, with proportionate search/sort/pagination.

Keep it cohesive with the OpenBoardCLI design system: shared utility classes and CSS variables only (never hardcoded colors), `var(--chart-N)` series colors, currency/number/date formatting via Intl and date-fns, main tab component plus small components in `components/` and pure helpers in `utils/`. Do not add new dependencies, do not embed raw rows in source, and do not build any upload UI.
