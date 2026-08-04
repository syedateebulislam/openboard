# UI flow tests

Drives a **real browser** over a generated OpenBoard app: every dashboard tab, at
several viewports and both themes, capturing a screenshot per screen and running
machine-checkable assertions against it.

```bash
npm run test:ui              # run the suite
npm run test:ui:report       # open the Playwright HTML report
```

Artifacts land in `tests/ui/__screens__/`:

| file | what it is |
|---|---|
| `<flow>/<name>.<viewport>.<theme>.png` | one screenshot per screen |
| `ui-report.md` | findings per screen, with the screenshot inline |
| `ui-report.json` | the same, for tooling |

`ui-report.md` is the artefact to read. It is the review surface: the assertions
below fail the build on their own, and the screenshots beside them are for the
judgement calls no assertion can make.

## What it checks without a human

- the app **compiles** — a generated dashboard that fails to parse takes the
  whole app down behind Vite's overlay, and every other check would otherwise
  report only that its elements are missing
- no console errors, no failed requests (a `401` from the session probe on the
  login screen is expected, and excluded)
- nothing renders `NaN`, `undefined`, `Invalid Date` or `[object Object]`
- no empty KPI cards
- no chart collapsed under 24px, and none that reserved space but **drew no
  data** — a legend with no pie looks fine to a height check
- no horizontal page overflow at any viewport
- every dashboard in the manifest is reachable and renders

## How it runs

- **Chrome you already have** (`channel: 'chrome'`) — no browser download.
- **Its own credentials.** The app is behind a login and the workspace `.env`
  holds only a bcrypt hash, so the harness starts Vite with a username and a
  random password it mints per run. Your password is never needed, and nothing
  secret is written to the repo.
- **Vite dev, not preview.** The auth and data API is a Vite *plugin*; a static
  preview of `dist/` has no backend, so every screen would be a login form that
  cannot succeed.
- **The tab list comes from the manifest**, never a hardcoded list, so the suite
  covers whatever dashboards you actually have.

### Choosing the workspace

The richest installed workspace under `projects/` wins. Override with:

```bash
OPENBOARD_UI_WORKSPACE="C:/path/to/workspace" npm run test:ui
```

**Close OpenBoard first**, or let its fetch finish. It regenerates dashboards in
place, and a suite photographing a directory being rewritten underneath it
produces diffs nobody can reproduce. A smoke test warns when the manifest was
touched in the last minute.

## When it finds something

Fixes go to `templates/dashboard/**` or the generation prompts — **never** to
`projects/**`. The generated workspace is output: edit it and the next
regeneration discards your change.

A finding that needs the model to rewrite a dashboard component is reported, not
fixed. This suite reports; it does not edit.
