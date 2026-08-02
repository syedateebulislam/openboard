# Invoice fetchers

One script per biller. Each connects to Gmail over IMAP, finds that biller's
invoice emails, parses them, and appends a row per invoice to its own CSV.

OpenBoard discovers, schedules and runs them, then builds a dashboard from the
CSV — but it never edits them. They are ordinary Python scripts you can run by
hand, and you are meant to add your own.

## Installing

Settings → Invoice fetchers → **Install the fetchers bundled with OpenBoard**.
That copies these files to `~/.openboard/billers/scripts/invoice_fetchers/` and
configures the path. Running it again only adds what is missing — a script you
have edited is never overwritten.

## Writing your own

Copy the closest existing fetcher and change the parsing. To be discovered, a
file needs three things:

1. A name matching `fetch_<biller>.py`.
2. Module-level `KEY` and `DISPLAY_NAME` constants. `KEY` becomes the dashboard
   selector and the CSV filename, so keep it `lower_snake_case`.
3. Paths derived two folders up from itself, exactly as the existing scripts do:

```python
REPO_ROOT = Path(__file__).resolve().parents[2]
CREDENTIALS_PATH = REPO_ROOT / "secrets" / "gmail_app_credentials.json"
CSV_PATH = REPO_ROOT / "data" / "invoices" / f"{KEY}.csv"
RAW_DIR  = REPO_ROOT / "data" / "invoices" / "raw" / KEY
```

That last point is what lets OpenBoard find your output without being told: it
reads the CSV back from the same derived location.

4. A `load_credentials()` that prefers the environment, so the App Password never
   has to sit on disk:

```python
def load_credentials() -> dict:
    email = os.environ.get("OPENBOARD_GMAIL_EMAIL")
    app_password = os.environ.get("OPENBOARD_GMAIL_APP_PASSWORD")
    if email and app_password:
        return {"email": email, "app_password": app_password}
    return read_json(CREDENTIALS_PATH)   # standalone runs still work
```

OpenBoard sets those two variables on the process it spawns. The file fallback is
only for running a fetcher by hand; OpenBoard no longer writes it, and deletes any
copy left by an older version. A fetcher written against the old contract is
patched in place on the next run, so existing scripts keep working.

A script that declares no `KEY`/`DISPLAY_NAME` is ignored, which is how helper
scripts sitting in the same folder stay out of the biller list — that is why
`probe_biller.py` and `parse_sample.py`, which Biller Studio uses, never appear
as billers.

## Let OpenBoard write it for you

You do not have to write any of this by hand. **Settings → Invoice fetchers →
`✚ Add a new biller (Biller Studio)`** takes a sender address and a subject
fragment, samples one real email, and generates a fetcher against this same
contract — then compiles it, checks what it extracts, and dry-runs it against
your mailbox before saving. Hand-writing is still supported and is the right
choice when the parsing is unusual.

## Contract OpenBoard relies on

| | |
|---|---|
| Invocation | `python fetch_<biller>.py [--since-days N] [--limit N] [--dry-run] [--log-level LEVEL]` |
| Credentials | `OPENBOARD_GMAIL_EMAIL` / `OPENBOARD_GMAIL_APP_PASSWORD` from the environment, falling back to `{"email": ..., "app_password": ...}` at the derived path for standalone runs |
| Output | append rows to `CSV_PATH`; write the header only when the file is new |
| Dedup | record handled message UIDs in `RAW_DIR/state.json` so re-runs are incremental |
| Exit code | `0` on success. Note OpenBoard also scans output for fatal errors, because these scripts catch connection failures and still exit `0` |

Only numeric and enum arguments are ever passed, and only files directly inside
the configured folder are executed.

## Dependencies

`beautifulsoup4` for all of them, plus `pdfplumber` for `fetch_rapido.py`, which
reads PDF receipts.

```bash
pip install beautifulsoup4 pdfplumber
```

## About the examples in these files

Each `parse()` carries a docstring showing the shape of the email it reads, so
the regexes are reviewable. Those examples are **synthetic** — order numbers,
amounts, merchants, names and vehicle numbers are placeholders. Keep them that
way: this folder ships to npm, and a published version cannot be truly
withdrawn. Real receipts you are working from belong in a scratch file, not here.
