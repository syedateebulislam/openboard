Build a polished, mobile-first travel & rides dashboard tab for this dataset that works for any booking or ride export (MakeMyTrip, Uber, Rapido, Ola, airline/hotel invoices, or similar) — never hardcode a provider's schema; infer the useful fields dynamically from the column names and value patterns in the data.

Data model (OpenBoardCLI):
- This dashboard tab loads its real rows at runtime from `useProtectedDashboardData('<dashboard-name>')`. There is NO file upload — derive every metric, chart, and table from that hook's rows.
- Dynamically detect the meaningful columns, case-insensitively: trip/booking date (ride_datetime/travel_date/document_date/booking_date/email_date — prefer the actual trip date), paid amount (total_paid/fare/amount/net_total — prefer the final paid amount), pickup/from and dropoff/to locations, mode/vehicle (auto/cab/bike/flight/train/hotel), provider/merchant, booking/ride id, discount, taxes, payment method, currency.
- Normalize rows in a `utils/` helper: parse amounts safely, parse dates with date-fns across common formats, never throw on bad input. Mark a row excluded when no valid amount or date is found, and keep an exclusion reason.

Layout (top to bottom):
- Choose 3-6 non-redundant KPIs from supported candidates such as tracked travel spend, trip count, typical trip cost, provider/mode concentration, largest trip, discounts, and coverage. Never claim distance or "longest" without a distance/duration field, and compare only complete periods.
- Apply the evidence-first Top Insights contract from the system prompt. Candidate questions include repeated-route cost changes, provider/mode concentration, observed peak-time differences, discounts captured, booking cadence, and unusual trips. Compare routes, modes, or times only with enough like-for-like records; never infer surge pricing or off-peak savings from timestamps and totals alone.
- Choose 1-4 Recharts views from supported candidates such as a supported period trend, provider/mode ranking, trip cadence, or repeated-route comparison. Include route analysis only when both endpoints are reliable and use a period control only with sufficient date span.
- Chart hygiene: explicit Recharts margin on every chart; horizontal bars need a fixed YAxis width (~140) with an ellipsis tickFormatter; cap dense time-axis ticks; format axis numbers compactly (12.4k); never render a pie/donut for a dimension with fewer than 2 meaningful values.
- Usually include a compact recent-trips table when record inspection is useful, newest first, with proportionate search/sort/pagination.

Keep it cohesive with the OpenBoardCLI design system: shared utility classes and CSS variables only (never hardcoded colors), `var(--chart-N)` series colors, currency/number/date formatting via Intl and date-fns, main tab component plus small components in `components/` and pure helpers in `utils/`. Do not add new dependencies, do not embed raw rows in source, and do not build any upload UI.
