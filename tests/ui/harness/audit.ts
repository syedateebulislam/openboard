/**
 * What a screen can be judged on without a human or a model looking at it.
 *
 * A screenshot proves nothing on its own — someone has to read it. These checks
 * are the part that can fail a build by itself: they encode the defects that
 * have actually shipped in generated dashboards (a KPI reading "NaN", a chart
 * collapsed to zero height, a table with neither rows nor an empty state) as
 * assertions rather than as things to notice.
 *
 * Everything here is a *finding*, not a throw. One screen can be wrong in
 * several ways at once, and the report is more useful than the first failure.
 */

import type { ConsoleMessage, Page, Request } from '@playwright/test';

export type Severity = 'error' | 'warning';

export interface Finding {
  screen: string;
  severity: Severity;
  rule: string;
  detail: string;
}

/** Values that mean "the data pipeline leaked its internals into the UI". */
const BROKEN_VALUE = /\b(NaN|undefined|null|Invalid Date|\[object Object\]|\$\{)/;

/**
 * Console noise that is not the app's fault.
 *
 * Vite's dev client and React DevTools both log unconditionally; failing on
 * those would make every run red for reasons no dashboard can fix.
 */
const IGNORED_CONSOLE = [
  /\[vite\]/i,
  /Download the React DevTools/i,
  /React Router Future Flag/i,
];

/**
 * Responses that mean the app is working, not failing.
 *
 * The session probe is the one that matters: on the login screen the app asks
 * `/api/auth` who you are, is told 401, and renders the form. That is the
 * feature behaving correctly — flagging it made every unauthenticated screen
 * fail with two errors that described normal operation.
 */
const EXPECTED_RESPONSES: Array<{ url: RegExp; status: number }> = [
  { url: /\/api\/auth$/, status: 401 },
];

/** The browser logs a generic line for any failed fetch; match it by status. */
const RESOURCE_ERROR = /Failed to load resource.*status of (\d{3})/;

export class ScreenAudit {
  readonly consoleErrors: string[] = [];
  readonly failedRequests: string[] = [];
  /** Statuses seen on expected endpoints, so their console echo can be dropped. */
  private readonly expectedStatuses = new Set<number>();

  constructor(private readonly page: Page) {
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
      this.consoleErrors.push(text);
    });
    page.on('requestfailed', (request: Request) => {
      const failure = request.failure()?.errorText ?? 'failed';
      // A navigation the test itself cancelled is not a defect.
      if (/ERR_ABORTED/.test(failure)) return;
      this.failedRequests.push(`${request.method()} ${request.url()} — ${failure}`);
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status < 400) return;
      if (EXPECTED_RESPONSES.some((rule) => rule.status === status && rule.url.test(response.url()))) {
        this.expectedStatuses.add(status);
        return;
      }
      this.failedRequests.push(`${response.request().method()} ${response.url()} — HTTP ${status}`);
    });
  }

  /** Reset between screens so a finding is attributed to the screen that caused it. */
  clear(): void {
    this.consoleErrors.length = 0;
    this.failedRequests.length = 0;
    this.expectedStatuses.clear();
  }

  /**
   * Drop the browser's generic "failed to load resource" line when it merely
   * echoes a response we already decided was expected. A real failure of the
   * same status still surfaces, because it also produces a request-failed
   * finding that is never filtered.
   */
  private meaningfulConsoleErrors(): string[] {
    return this.consoleErrors.filter((text) => {
      const match = RESOURCE_ERROR.exec(text);
      return !match || !this.expectedStatuses.has(Number(match[1]));
    });
  }

  /**
   * The dev server's compile-error overlay, if it is up.
   *
   * A generated dashboard that does not parse takes the whole app down: Vite
   * covers every route with this overlay, so each screen reports only that its
   * elements are missing. The first run of this suite failed 28 tests that way
   * and none of them named the cause. Reading the overlay turns all of that
   * into one accurate sentence.
   */
  static async compileError(page: Page): Promise<string | undefined> {
    return page.evaluate(() => {
      const overlay = document.querySelector('vite-error-overlay');
      if (!overlay) return undefined;
      const shadow = (overlay as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
      const message = shadow?.querySelector('.message')?.textContent ?? '';
      const file = shadow?.querySelector('.file')?.textContent ?? '';
      return `${message.trim()} ${file.trim()}`.trim() || 'Vite reported a build error.';
    });
  }

  async run(screen: string): Promise<Finding[]> {
    const findings: Finding[] = [];
    const add = (severity: Severity, rule: string, detail: string) =>
      findings.push({ screen, severity, rule, detail });

    const compile = await ScreenAudit.compileError(this.page);
    if (compile) {
      // Nothing else on this screen is meaningful while the app is broken.
      add('error', 'does-not-compile', compile);
      return findings;
    }

    for (const error of dedupe(this.meaningfulConsoleErrors())) add('error', 'console-error', error);
    for (const failure of dedupe(this.failedRequests)) add('error', 'request-failed', failure);

    const probe = await this.page.evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const textOf = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();

      // Cards/KPIs/charts/tables by the template's own class and tag vocabulary,
      // so this keeps working when the LLM names components differently.
      const cards = [...document.querySelectorAll('.card, [class*="kpi" i], [class*="stat" i]')].filter(visible);
      // One entry per chart. Matching wrapper, surface and canvas together
      // counted a single Recharts chart three times, so "3 of 9 collapsed"
      // actually meant one empty chart out of three — a real defect reported
      // with numbers that invited disbelief.
      const chartRoots = [...document.querySelectorAll('.recharts-wrapper')];
      const standalone = [...document.querySelectorAll('canvas')]
        .filter((el) => !chartRoots.some((root) => root.contains(el)));
      const charts = [...chartRoots, ...standalone].filter(visible);
      const tables = [...document.querySelectorAll('table')].filter(visible);

      const bodyText = textOf(document.body);

      return {
        bodyText: bodyText.slice(0, 20000),
        bodyLength: bodyText.length,
        cardCount: cards.length,
        emptyCards: cards.filter((card) => textOf(card).length === 0).length,
        chartCount: charts.length,
        collapsedCharts: charts.filter((chart) => chart.getBoundingClientRect().height < 24).length,
        // A chart box that reserved its space but drew nothing. The airtel
        // "Payment method mix" pie rendered its legend and an empty circle —
        // a height check cannot see that, because the card is full height.
        emptyCharts: chartRoots.filter((root) => {
          if (root.getBoundingClientRect().height < 24) return false;
          const marks = root.querySelectorAll(
            '.recharts-pie-sector, .recharts-bar-rectangle, .recharts-line-curve,' +
            ' .recharts-area-area, .recharts-scatter-symbol, .recharts-radial-bar-sector',
          );
          return marks.length === 0;
        }).length,
        tableCount: tables.length,
        emptyTables: tables.filter((table) => table.querySelectorAll('tbody tr').length === 0).length,
        // Horizontal overflow: the page itself scrolling sideways is a layout
        // bug; an inner container with its own overflow-x is intentional.
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
        overflowing: [...document.querySelectorAll('body *')]
          .filter(visible)
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.right > document.documentElement.clientWidth + 2 && rect.width > 40;
          })
          .slice(0, 5)
          .map((element) => `${element.tagName.toLowerCase()}.${(element.className || '').toString().split(' ')[0]}`),
      };
    });

    if (probe.bodyLength < 40) {
      add('error', 'blank-screen', `Rendered only ${probe.bodyLength} characters of text.`);
    }

    const broken = probe.bodyText.match(new RegExp(BROKEN_VALUE, 'g'));
    if (broken) {
      add('error', 'broken-value', `Rendered ${unique(broken).join(', ')} — a value reached the UI unformatted.`);
    }

    if (probe.emptyCards > 0) {
      add('error', 'empty-card', `${probe.emptyCards} of ${probe.cardCount} cards rendered with no content.`);
    }

    if (probe.collapsedCharts > 0) {
      add('error', 'collapsed-chart', `${probe.collapsedCharts} of ${probe.chartCount} charts rendered under 24px tall.`);
    }

    if (probe.emptyCharts > 0) {
      add('error', 'empty-chart', `${probe.emptyCharts} of ${probe.chartCount} charts drew no data (axes/legend only).`);
    }

    if (probe.emptyTables > 0) {
      // A table with no rows and no empty state looks identical to one still loading.
      add('warning', 'empty-table', `${probe.emptyTables} of ${probe.tableCount} tables have no rows.`);
    }

    if (probe.docScrollWidth > probe.docClientWidth + 2) {
      add(
        'error',
        'horizontal-overflow',
        `Page scrolls sideways (${probe.docScrollWidth}px into ${probe.docClientWidth}px)` +
          (probe.overflowing.length ? `; widest: ${probe.overflowing.join(', ')}` : ''),
      );
    }

    return findings;
  }
}

const unique = (values: string[]) => [...new Set(values)];
const dedupe = (values: string[]) => unique(values).slice(0, 5);
