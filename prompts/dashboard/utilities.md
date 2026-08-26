Build a clean, mobile-first utilities & bills dashboard tab for this dataset that works for any biller export (telecom/broadband like Airtel/Jio, electricity, water, gas, society/maintenance like NoBrokerHood, or similar) — never hardcode a biller's schema; infer the useful fields dynamically from the column names and value patterns in the data.

Data model (OpenBoardCLI):
- This dashboard tab loads its real rows at runtime from `useProtectedDashboardData('<dashboard-name>')`. There is NO file upload — derive every metric, chart, and table from that hook's rows.
- Dynamically detect the meaningful columns, case-insensitively: bill/receipt date (document_date/bill_date/paid_date/email_date — prefer the bill date), paid amount (total_paid/amount/net_total — prefer the final paid amount), biller/merchant/service, description/plan, taxes (gst/vat), due date, billing period, payment method, currency.
- Normalize rows in a `utils/` helper: parse amounts safely, parse dates with date-fns across common formats, never throw on bad input. Group rows by normalized biller/service to compare bills across cycles. Mark a row excluded when no valid amount or date is found, and keep an exclusion reason.

Layout (top to bottom):
- Choose 3-6 non-redundant KPIs from supported candidates such as tracked bills paid, current complete-period spend, typical bill by service, largest bill, observed taxes, due-date performance, and coverage. Keep currencies separate and compare only complete cycles.
- Apply the evidence-first Top Insights contract from the system prompt. Candidate questions include cycle-over-cycle bill changes for the same service, concentration, observed taxes, late-payment patterns when due dates exist, and duplicate charges. Never claim tax leakage, a cheaper plan, or overlapping service without fields that directly support that conclusion.
- Choose 1-4 Recharts views from supported candidates such as a supported bill trend, like-for-like service comparison across cycles, or biller ranking. Include a period control only with sufficient cycles and avoid multi-line clutter when many services exist.
- Chart hygiene: explicit Recharts margin on every chart; horizontal bars need a fixed YAxis width (~140) with an ellipsis tickFormatter; cap dense time-axis ticks; format axis numbers compactly (12.4k); never render a pie/donut for a dimension with fewer than 2 meaningful values.
- Usually include a compact recent-bills table when record inspection is useful, newest first, with proportionate search/sort/pagination.

Keep it cohesive with the OpenBoardCLI design system: shared utility classes and CSS variables only (never hardcoded colors), `var(--chart-N)` series colors, currency/number/date formatting via Intl and date-fns, main tab component plus small components in `components/` and pure helpers in `utils/`. Do not add new dependencies, do not embed raw rows in source, and do not build any upload UI.
