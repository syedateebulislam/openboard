# Rebranding Changes

Everything that carries the product's brand identity, and what it costs to change each one.

This is a maintainer document. It is **not** in `package.json` `files`, so it does not ship
in the npm tarball — keep it that way unless you want users reading it.

The brand is not a string; it is about twenty categories spread across source, the dashboard
template, the LLM prompts, the docs, the test suite, CI, and nine shipped Python scripts.
Several values look cosmetic but are load-bearing: renaming them breaks installs that already
exist, and a few fail *silently* — no test goes red, the damage shows up in a user's terminal
weeks later. The tiers below are ordered by that risk, not by effort.

---

## 0. Pick your values first

Decide all of these before editing anything. Every later section refers to them.

| Placeholder | Replaces | Notes |
|---|---|---|
| `<NEW_NAME>` | `OpenBoard` | The wordmark, as written in prose and headings |
| `<NEW_NAME_SPACED>` | `O p e n B o a r d` | Banner only — letter-spaced, see §1.1 for the arithmetic |
| `<NEW_SLUG>` | `openboard` | Lowercase, used in dirs, filenames, slugs. **Tier 3** |
| `<NEW_PKG>` | `openboard-cli` | npm package name. **Tier 3** |
| `<NEW_BIN>` | `openboard` | The command users type. **Tier 3** |
| `<NEW_ENV_PREFIX>` | `OPENBOARD_` | **Tier 3** |
| `<NEW_SITE_URL>` | `https://openboard-site.vercel.app` | |
| `<NEW_REPO_URL>` | `https://github.com/syedateebulislam/openboard` | |
| `<NEW_NPM_URL>` | `https://www.npmjs.com/package/openboard-cli` | |
| `<NEW_ACCENT>` | `#c17f53` dark / `#a8642f` light | Also exists as a decimal ANSI triple, see §1.2 |

**Scope choice.** Tiers 1–2 are a display-name rebrand: safe, no migration, existing installs
keep working. Tier 3 is an identity rename and needs migration code. You can ship Tiers 1–2
alone and stop — the product looks rebranded and nothing breaks. Doing Tier 3 without the
migrations in §3 will break every existing user.

---

## 1. Tier 1 — Cosmetic (safe, but two silent traps)

### 1.1 The ASCII banner — hand-padded to 39 chars in three files

The box is not computed. It is typed out, and centred by hand, in three places that must stay
byte-identical:

- `src/index.tsx:197-201` — the `--version` path (raw ANSI, no Ink)
- `src/screens/WelcomeScreen.tsx:62-78` — the Ink welcome screen
- `user-manual.md:40-44` — the docs copy

against `BANNER_INNER_WIDTH = 39` in `src/version.ts:13`.

Only the **version line** is computed (`bannerVersionLine()`), and only *its* width is tested.
A new name of a different length silently un-centres the name and tagline lines. Nothing goes
red; the box just looks crooked.

**The arithmetic.** The name line is the ASCII mark + a space + the wordmark, centred in 39.
Both the mark and the wordmark can change length, so compute from scratch each time:

```
inner        = 39
prefix       = mark + " "                   -> e.g. "[>_] " = 5, "[_-_] " = 6
wordmark     = N letters, plain             -> N
             | N letters, single-spaced     -> 2N - 1
content      = prefix + wordmark
padTotal     = 39 - content
padLeft      = floor(padTotal / 2)          # extra space goes right, matching
padRight     = padTotal - padLeft           # bannerVersionLine()
```

Worked examples:

```
[>_]  + OpenBoardCLI (N=12):  content 17, pad 22 -> 11 left, 11 right
║           [>_] OpenBoardCLI           ║

[_-_] + OpenBoardCLI (N=12):  content 18, pad 21 -> 10 left, 11 right
║          [_-_] OpenBoardCLI           ║

[_-_] + O p e n B o a r d    (N=9):   content 23, pad 16 ->  8 left,  8 right
║        [_-_] O p e n B o a r d        ║
```

`padTotal` may land odd, putting the line half a character left of centre — invisible in
practice, and the same convention `bannerVersionLine()` already uses.

If `padTotal` is odd the box cannot be perfectly centred; put the extra space on the right and
accept it, or change `BANNER_INNER_WIDTH` — but note **`tests/phase1/version-banner.test.ts:47-52`
asserts `bannerVersionLine().length === BANNER_INNER_WIDTH`**, so if you change the constant the
box border strings (`╔═…═╗`, `╚═…═╝`, all `═` runs) must be re-drawn to the same width in all
three files.

Also update the tagline line (`Analytics Dashboard Generator`, 29 chars, 5 pad each side) if
the tagline changes.

### 1.2 Brand colours live in two notations

`src/theme.ts:2-4` holds the hex:

```ts
logo: '#C17F53',   border: '#8B7355',   subtitle: '#DCDCDC',
```

`src/index.tsx:192-194` duplicates them as **decimal** ANSI truecolour, because the `--version`
path prints before Ink loads:

```ts
const L = '\x1b[38;2;193;127;83m'; // #C17F53
const F = '\x1b[38;2;139;115;85m'; // #8B7355
const S = '\x1b[38;2;220;220;220m'; // #DCDCDC
```

Change both, convert hex→decimal correctly, and fix the trailing comments. Nothing tests this.

### 1.3 Prose and copy

- **TUI copy** — `src/App.tsx`, `src/screens/*.tsx` (Welcome, Chat, SetupWizard, BillerStudio,
  GmailIntegration, ManageBoards), `src/utils/commandParser.ts`.
- **CLI help + errors** — `src/index.tsx`: the `meow` help template and ~15 error/log strings.
  Note the command examples use `<NEW_BIN>`, which is Tier 3 — leave them alone for a
  display-only rebrand.
- **Docs** — `README.md`, `user-manual.md`, `Agent.md`, `arch.md`. Change the **CamelCase**
  brand prose only; the lowercase `openboard` in commands and paths is `<NEW_SLUG>`/`<NEW_BIN>`
  and belongs to Tier 3.
- **Prompt corpus** — the 15 files under `prompts/**/*.md`. These ship in the tarball *and* are
  fed to the LLM, so they shape generated-app copy.
- **`NOTICE:1,5`** — product name and site URL. `LICENSE` is verbatim Apache-2.0 with an
  unfilled copyright appendix; it contains no brand string and needs no edit.
- **Diagrams** — `docs/architecture.mmd` and `docs/current-flow.mmd` carry brand node labels;
  the committed `.svg` twins have the text baked in. Edit the `.mmd`, then regenerate the `.svg`.
- **CI identity** — `.github/workflows/ci.yml:36,60` sets `user.name "OpenBoard CI"`. The paired
  `user.email "ci@openboard.dev"` is a domain that appears nowhere else in the repo and is
  almost certainly fictional; treat it as Tier 3.

---

## 2. Tier 2 — The dashboard template and the prompts

### 2.1 `templates/dashboard/` ships in the tarball and lands in every generated app

| What | Where |
|---|---|
| Wordmark, app header | `src/App.tsx:41` — `<h1 className="app-title">OpenBoard</h1>` |
| Wordmark, login screen | `src/components/LoginPage.tsx:40` |
| Empty-state copy (brand ×2) | `src/App.tsx:60` |
| The `[>_]` mark as SVG paths | `src/components/BrandLogo.tsx` **and** `public/favicon.svg` — same four commands, one theme-aware and one hardcoded |
| Three brand URLs + labels | `src/components/HeaderLinks.tsx:10,15,20` |
| `aria-label`s | `BrandLogo.tsx:13`, `HeaderLinks.tsx:28`, `DashboardTabs.tsx:121,143` |
| Palette | `src/App.css` dark tokens `:11-51`, light tokens `:55-86` |
| Palette, duplicated as raw hex | `src/index.css:8,9,16,17` — outside the token system |
| Brand-named CSS classes | `.app-brand`, `.app-title` in `src/App.css` |

**The logo is drawn twice.** `BrandLogo.tsx` uses CSS variables and `public/favicon.svg` uses
hardcoded hex (`#0b0b0d`, `#c17f53`), but the five path commands are identical. Edit one and
they drift. There is no test for the drift.

**Two things here change end-user state silently:**

- `src/hooks/useTheme.ts:5` — `STORAGE_KEY = 'openboard-theme'`. Renaming it resets the theme
  for everyone who has already visited a deployed dashboard. Tier 3; leave it for a display rebrand.
- `templates/dashboard/api/_auth.ts` — the `auth_token` cookie is already brand-neutral.
  **Do not rename it.** It would log every viewer out and buys nothing.

### 2.2 The LLM prompts — the highest-leverage thing to miss

These instruct the model to write the wordmark into **newly generated** dashboards. Miss them
and the old brand keeps appearing in dashboards created after the rebrand, which reads as the
rebrand having failed:

- `src/services/llm/prompts/systemPrompt.ts:54-59,130-134` — the `BRAND & THEMING` block, and
  the prose description of the visual identity
- `src/services/llm/prompts/componentGenerationPrompt.ts:32,37`
- `src/screens/ChatScreen.tsx:1578` — *"Keep the centered master header text exactly
  \"OpenBoard\""*
- `src/services/project/DashboardUpdateService.ts:173` — the literal
  `<h1 className="app-title">OpenBoard</h1>` the model is told to preserve
- `src/services/project/DashboardManifestService.ts:108` — the generated-file header comment
- `src/services/deploy/GitHubService.ts:149` — a comment written into user repos' `.gitignore`

Treat this section as breaking even in a display-only rebrand.

---

## 3. Tier 3 — Identity rename (breaking; each needs a migration)

Do not do any of these without the paired migration.

| Value | Every site | Migration |
|---|---|---|
| `~/.openboard` | Re-derived in **6** places: `ConfigService.ts:136` and `:261`, `logger.ts:26`, `types/billers.ts:29`, `RunStateService.ts:61`, `OpenAICodexProvider.ts:49` | On startup: if the new dir is absent and the old one exists, copy it forward once, then use the new one. **Introduce a single shared constant while you are in there** so this is never six edits again. |
| 14 `OPENBOARD_*` env vars read by shipped code | `ConfigService`, `logger`, `LoadingRemark`, `index.tsx`, `OpenAICodexProvider`, `VercelService`, `SetupService`, `BillerFetcherService`, `BillerDiscoveryService`, plus 9 `scripts/invoice_fetchers/*.py` | Read the new name first, fall back to the old one with a one-time deprecation warning. The Python fetchers are a subprocess contract — `BillerScriptWriter.ts` scans for the `OPENBOARD_GMAIL_` prefix in an allow-list. |
| npm package `openboard-cli` | `package.json:2` | Publish under the new name, then `npm deprecate openboard-cli "renamed to <NEW_PKG>"`. You cannot rename in place. |
| binary `openboard` | `package.json:32`, echoed in ~35 help/error strings in `src/index.tsx` and ~108 doc examples | Ship both `bin` entries for one major version, then drop the old. |
| `# <<OPENBOARD:NAME>>` region markers | `skeletonRegions.ts:22,25,128`, `scripts/dev/add_region_markers.mjs:17-18`, and markers already written into users' `~/.openboard/billers/scripts/*.py` | Parse **both** old and new marker names; only ever *write* the new one. |
| `.openboard.lock` | `ProjectLockService.ts:21` | A stale lock from an older version becomes invisible to the new one. Check for both names. |
| `openboard.log` | `logger.ts:27` | Harmless to change. Note it is documented nowhere. |
| project slug `openboard-<type>-<name>-<uuid8>` | `ProjectManager.ts:117` | Existing dirs are recorded as absolute paths in `workspace.projectDir`, so old ones keep working; old and new naming will coexist on disk. |
| Vercel project fallback `openboard-workspace` | `VercelService.ts:110-111`, `TemplateService.ts:128`, `ProjectManager.ts:139`, `DashboardUpdateService.ts:987` | This is a **live deployment URL**. Changing it creates a *new* Vercel project; the old URL keeps serving the old app. |
| git sentinel `openboard@local` | `GitHubService.ts:28` | `ensureCommitAuthor` rejects this placeholder. CI deliberately sets a real identity to avoid it. |

### Never change this

```
src/services/config/ConfigService.ts:103
  const ENCRYPTION_KEY_SALT = 'openboard-config-encryption-v1';
```

The salt derives the key for every stored credential. Changing it does not error — it makes
every existing encrypted value undecryptable. Pin it, and leave a comment saying why. If you
ever must rotate it, decrypt-with-old / re-encrypt-with-new on startup, gated on a version flag.

### Already brand-neutral — leave alone

- The deployed app's env vars are `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD_HASH_B64`,
  `JWT_SECRET` (`VercelService.ts:408-412`, `types/deployment.ts:54-56`).
  ⚠️ `AuthService.ts:36-38` claims they are `OPENBOARD_USERNAME` / `OPENBOARD_PASSWORD_HASH` /
  `OPENBOARD_JWT_SECRET`. **That comment is wrong** — those names are set nowhere. Fix the
  comment; do not go hunting for the vars.
- The `auth_token` cookie (`api/_auth.ts:19,29,33`).
- The `Board*` type family (`BoardConfig`, `BoardType`, `BoardRegistryService`, …). "Board" is
  the internal word for *dashboard*, not the brand. Renaming is a pure refactor with no user
  impact — but the store keys `'boards'` and `'workspace.*'` **are** persisted, so those are Tier 3.
  (Note there are two different `BoardConfig` interfaces — `types/board.ts:8` and
  `types/config.ts:34` — a pre-existing collision. Don't let a rename merge them by accident.)
- The `{{BOARD_NAME}}` / `{{BOARD_TITLE}}` template variables (`TemplateService.ts:390-393`).
  Renaming them means updating `tests/phase1/template-service.test.ts:82-95` and
  `tests/phase7/project-manager.test.ts:130-132`.

---

## 3b. The other repo — `openboard-site`

**The brand lives in two repositories.** The landing page is a separate private repo,
`syedateebulislam/openboard-site` (checked out alongside this one). It is a static site —
`index.html`, `llms.txt`, `README.md`, `assets/`, `favicon.svg` — and it deploys to Vercel on
push to `main`, so a rebrand there is immediately public.

| What | Where |
|---|---|
| `<title>`, `og:title`, meta description | `index.html` head |
| Logo lockup — ASCII mark + wordmark | `index.html`, header `.brand` **and** footer `.foot-row` |
| The mark again, as SVG paths | `favicon.svg` — a **third** copy of the same geometry, independent of the CLI repo's two |
| Prose | `index.html`, `llms.txt`, `README.md`, `assets/main.js`, `assets/style.css` |
| **The TUI screenshot** | `assets/tui.png` — a raster mock of the welcome screen |
| The screenshot's `alt` text | `index.html`, describes the banner *and quotes the version* |

Two traps specific to this repo:

- **`assets/tui.png` is a picture of the banner**, so it carries the old mark, the old wordmark
  *and* a pinned version number. It cannot be found by grep, and it goes stale on every release,
  not just on a rebrand. Regenerate it from the live frame in
  `tests/ui/__screens__/tui/welcome.txt` rather than redrawing it by hand; render at 842×690 CSS
  px with `deviceScaleFactor: 2` to match the committed 1684×1380 and the `<img width/height>`.
- **The `alt` text repeats the banner in prose**, version included. It is the one place a stale
  version is invisible to both a grep for the mark and to a glance at the page.

Keep lowercase `openboard` in this repo untouched for a display-only rebrand — on the site it is
almost always the command, the package, or a GitHub URL.

## 4. Tests that will go red

Update these in the same commit as the rename that breaks them.

| Test | Asserts |
|---|---|
| `tests/phase9/master-tab.test.ts:50-52,58` | the three `HeaderLinks` URLs verbatim, and `className="app-brand"` |
| `tests/phase7/project-manager.test.ts:82,122` | project slug regexes `/^openboard-finance-…/`, `/^openboard-health-…/` |
| `tests/phase7/project-manager.test.ts:312` | `--accent: #c17f53` in the synced `App.css` |
| `tests/phase9/bulk-operations.test.ts:489-490` | the literal wordmark and `BrandLogo` in the restored shell |
| `tests/phase9/ui-defaults.test.ts:56-57` | whitespace-exact `.app-brand` CSS regexes |
| `tests/phase9/codex-home.test.ts:26,30,51` | `join(homedir(), '.openboard', 'codex-home')` |
| `tests/phase8/agent-pipeline.test.ts:296-361` | `.openboard.lock` and `'Another OpenBoard operation'` |
| `tests/phase5/vercel-service.test.ts:216,235,251,261,409` | `openboard-workspace` and a deploy URL |
| `tests/phase5/github-service.test.ts:149,185-198` | `openboard@local`, `'Fix OpenBoard deployment author'` |
| `tests/phase18/failure-summary.test.ts:13` | `'Project is locked by another OpenBoard run…'` |
| `tests/phase16/credential-migration.test.ts:82`, `generated-code-guard.test.ts:57-58` | `OPENBOARD_GMAIL_*` |
| `tests/phase18/skeleton-regions.test.ts:125,131,175,214` | the `# <<OPENBOARD:…>>` marker syntax |
| `tests/phase1/version-banner.test.ts:28,31,47-52` | banner width; and that `user-manual.md` contains ≥1 `vX.Y.Z` all equal to `package.json` |
| `tests/phase18/navigation-shell.test.tsx:94` | the banner wordmark in the welcome frame |
| `scripts/test-openboard-flows.ps1` (`version` case) | the banner wordmark in `--version` output (dev script, not run in CI) |

**Playwright — fails slowly, not loudly.** `tests/ui/harness/fixtures.ts:124,154` and
`tests/ui/specs/auth.spec.ts:37,48` select on
`nav[aria-label="OpenBoard dashboards"]` (`templates/dashboard/src/components/DashboardTabs.tsx:121,143`).
Rename the `aria-label` without updating these and every logged-in spec waits 20 s, then fails.

**Pixel baselines.** The 24 PNGs under `tests/ui/__baseline__/` contain the rendered wordmark,
logo and accent colour. Any visual brand change fails all of them; re-accept with
`npm run test:ui:accept`. The `.txt` frames under `tests/ui/__screens__/` are gitignored
artifacts and are not asserted — they will just look stale.

---

## 5. Silent failures — no test catches these

1. `README.md:28,36` embed the architecture diagrams from
   `raw.githubusercontent.com/<owner>/<repo>/main/docs/*.svg`. A repo rename leaves **broken
   images on GitHub and on the npm package page**.
2. Banner centring (§1.1).
3. `BrandLogo.tsx` / `favicon.svg` drifting apart (§2.1).
4. The LLM prompts (§2.2) — the rebrand looks complete until the next dashboard is generated.
5. `src/theme.ts` hex vs `src/index.tsx` decimal ANSI (§1.2).
6. **`NOTICE` has no file extension.** Any rename script that walks the tree filtering on
   `.md`/`.ts`/… will skip it, and it ships in the npm tarball as the attribution file.
   `LICENSE` is extensionless too, but carries no brand string. Sweep by content, not by extension.
7. **A letter-spaced banner is invisible to a token search.** `O p e n B o a r d` does not
   contain `OpenBoard`, so find/replace silently leaves it — in three source files *and* in
   two assertions (`tests/phase18/navigation-shell.test.tsx:94`, and the `--version`
   `MustContain` in `scripts/test-openboard-flows.ps1`). The banner is currently set plain,
   so this only bites if someone letter-spaces it again.

---

## 6. Order of work

1. Fill in every placeholder in §0 and decide the tier.
2. Tier 1: banner (compute padding first), colours, TUI copy, docs, prompt corpus, NOTICE, diagrams.
3. Tier 2: template wordmark, logo ×2, HeaderLinks, aria-labels, palette (`App.css` + `index.css`).
4. Tier 2b: the LLM prompts.
5. Tier 3 (only if in scope): each row of §3 **with** its migration.
6. Update the tests in §4.
7. Verify with §7.

## 7. Verification

```bash
npx tsc --noEmit
npm run build
node dist/index.js --version          # eyeball the banner box alignment
npm run test:run                      # full unit suite
npm run test:ui:tui                   # regenerates tests/ui/__screens__/tui/*.txt
```

Then:

```bash
# What still carries the old brand? Every hit must be intentional.
rg -i -o "openboard[a-z0-9_-]*" --stats \
   -g '!node_modules' -g '!dist' -g '!projects' \
   -g '!tests/ui/.playwright-report' -g '!tests/ui/.artifacts' \
   -g '!tests/ui/__screens__' -g '!tests/ui/__baseline__'

# Env-var inventory: expect 14 shipped-code names, 1 sentinel
# (OPENBOARD_CREDENTIAL_READ), 7 test/tooling names.
rg -o "OPENBOARD_[A-Z0-9_]+" -g '!node_modules' | sort -u

npm pack --dry-run                    # this file must NOT be listed
```

Read `tests/ui/__screens__/tui/welcome.txt` and confirm the box is square — the frame test
only asserts the frame is non-empty, so this is a human check.

For a Tier 3 rename, also test the migration by hand: put a config in the *old* directory,
run the new build, and confirm it is picked up, copied forward, and that stored credentials
still decrypt.
