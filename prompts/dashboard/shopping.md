Build a polished, mobile-first shopping & orders dashboard tab for this dataset that works for any e-commerce export (Amazon, Flipkart, order-history CSVs, or similar) — never hardcode a store's schema; infer the useful fields dynamically from the column names and value patterns in the data.

Data model (OpenBoardCLI):
- This dashboard tab loads its real rows at runtime from `useProtectedDashboardData('<dashboard-name>')`. There is NO file upload — derive every metric, chart, and table from that hook's rows.
- Dynamically detect the meaningful columns, case-insensitively: order date (order_date/document_date/email_date — prefer the actual order date), paid amount (total_paid/order_total/amount — prefer the final paid amount), merchant/seller, item/product/description, category, quantity, discount, taxes, refunds/returns, order id, payment method, currency.
- Normalize rows in a `utils/` helper: parse amounts safely, parse dates with date-fns across common formats, never throw on bad input; treat refunds/negative amounts correctly. Mark a row excluded when no valid amount or date is found, and keep an exclusion reason.

Layout (top to bottom):
- Choose 3-6 non-redundant KPIs from supported candidates such as tracked spend, order count, typical order value, largest order, observed discounts/refunds, and coverage. Keep currencies separate and show deltas only for complete comparable periods.
- Apply the evidence-first Top Insights contract from the system prompt. Candidate questions include seller/category concentration, material period changes, unusual orders, discounts actually captured, refunds observed, and repeat-item price changes. Require comparable periods or items before claiming growth, decline, or a cheaper option; do not manufacture purchase advice from category totals.
- Choose 1-4 Recharts views from supported candidates such as a period trend, seller/category ranking, order cadence, or observed discount/refund comparison. Include a trend only with sufficient date span and omit unsupported or duplicate views.
- Chart hygiene: explicit Recharts margin on every chart; horizontal bars need a fixed YAxis width (~140) with an ellipsis tickFormatter; cap dense time-axis ticks; format axis numbers compactly (12.4k); never render a pie/donut for a dimension with fewer than 2 meaningful values.
- Usually include a compact recent-orders table when record inspection is useful, newest first, with proportionate search/sort/pagination.

Keep it cohesive with the OpenBoardCLI design system: shared utility classes and CSS variables only (never hardcoded colors), `var(--chart-N)` series colors, currency/number/date formatting via Intl and date-fns, main tab component plus small components in `components/` and pure helpers in `utils/`. Do not add new dependencies, do not embed raw rows in source, and do not build any upload UI.
