#!/usr/bin/env python3
"""Standalone Amazon order invoice fetcher.

Self-contained: connects to Gmail over IMAP, finds Amazon order emails, parses
order details, and appends them to a per-biller CSV. No dependency on any other
script.

Usage:
    python scripts/invoice_fetchers/fetch_amazon.py [--since-days N] [--limit N] [--dry-run]

Requires: beautifulsoup4
Credentials: secrets/gmail_app_credentials.json  -> { "email": ..., "app_password": ... }
"""

import argparse
import csv
import datetime as dt
import email
import email.message
import imaplib
import json
import logging
import os
import re
import sys
from email.header import decode_header
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Dict, List, Tuple

from bs4 import BeautifulSoup

# ── Biller config ────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parents[2]
CREDENTIALS_PATH = REPO_ROOT / "secrets" / "gmail_app_credentials.json"

KEY = "amazon"
DISPLAY_NAME = "Amazon"
SENDER_EMAIL = "shipment-tracking@amazon.in"
SUBJECT_PREFIX = ""  # filtering handled by is_receipt() (subject must start with "Shipped:")
CSV_PATH = REPO_ROOT / "data" / "invoices" / "amazon.csv"
RAW_DIR = REPO_ROOT / "data" / "invoices" / "raw" / "amazon"
STATE_PATH = RAW_DIR / "state.json"
DEFAULT_SINCE_DAYS = 120
SEARCH_LIMIT = 500

COLUMNS = [
    "source_sender",
    "email_uid",
    "email_subject",
    "email_date",
    "order_id",
    "status",
    "product_name",
    "quantity",
    "item_price",
    "order_total",
    "currency",
    "arriving",
    "recipient",
    "location",
]


# ── Shared helpers (inlined so this script stands alone) ──────────────────────
def read_json(path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_credentials() -> dict:
    """Gmail IMAP credentials, preferring the environment over the disk.

    OpenBoard passes OPENBOARD_GMAIL_EMAIL and OPENBOARD_GMAIL_APP_PASSWORD to
    this process so the App Password never has to be written to a file. Running
    the script by hand still works: it falls back to the credentials JSON this
    fetcher has always read.
    """
    email = os.environ.get("OPENBOARD_GMAIL_EMAIL")
    app_password = os.environ.get("OPENBOARD_GMAIL_APP_PASSWORD")
    if email and app_password:
        return {"email": email, "app_password": app_password}
    return read_json(CREDENTIALS_PATH)


def load_state(path) -> List[str]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_state(path, uids: List[str]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sorted(set(uids), key=lambda x: int(x)), f, indent=2)


def decode_str(value: str) -> str:
    if not value:
        return ""
    try:
        parts = decode_header(value)
    except Exception:
        return value
    decoded = []
    for text, charset in parts:
        if isinstance(text, bytes):
            charset = charset or "utf-8"
            try:
                decoded.append(text.decode(charset, errors="replace"))
            except LookupError:
                decoded.append(text.decode("utf-8", errors="replace"))
        else:
            decoded.append(text)
    return "".join(decoded)


def normalize_amount(value: str):
    if not value:
        return ""
    cleaned = re.sub(r"[^0-9.\-]", "", value)
    if not cleaned:
        return ""
    try:
        return round(float(cleaned), 2)
    except ValueError:
        return ""


def find_first(patterns: List[str], text: str) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return ""


def sanitize_filename(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def parse_email_date(value: str) -> str:
    if not value:
        return ""
    try:
        return parsedate_to_datetime(value).isoformat()
    except Exception:
        return value


def format_since(days: int) -> str:
    since = dt.datetime.utcnow() - dt.timedelta(days=days)
    return since.strftime("%d-%b-%Y")


def recreate_if_schema_changed(csv_path, state_path) -> None:
    """If an existing CSV uses a different header, archive it and reset state so
    the CSV is rebuilt from scratch with the current COLUMNS."""
    if not os.path.exists(csv_path):
        return
    try:
        with open(csv_path, "r", newline="", encoding="utf-8") as f:
            header = next(csv.reader(f), [])
    except Exception:
        header = []
    if header == COLUMNS:
        return
    backup = f"{csv_path}.bak"
    try:
        if os.path.exists(backup):
            os.remove(backup)
        os.rename(csv_path, backup)
        logging.info("[%s] CSV schema changed; archived old CSV to %s", KEY, backup)
    except Exception as exc:
        logging.warning("[%s] Could not archive old CSV: %s", KEY, exc)
    if os.path.exists(state_path):
        try:
            os.remove(state_path)
            logging.info("[%s] Reset state to rebuild CSV", KEY)
        except Exception as exc:
            logging.warning("[%s] Could not reset state: %s", KEY, exc)


def ensure_csv(path) -> None:
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=COLUMNS).writeheader()


def append_csv(path, row: Dict[str, str]) -> None:
    ensure_csv(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=COLUMNS).writerow(row)


def save_file(path, data: bytes, dry_run: bool) -> None:
    if dry_run:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def fetch_bodies_and_attachments(msg, raw_dir, uid: str, dry_run: bool) -> Tuple[str, str, List[str]]:
    """Return (html_body, plain_body, saved_attachment_paths)."""
    html_body = ""
    plain_body = ""
    saved_files = []
    for part in msg.walk():
        content_type = part.get_content_type()
        content_disposition = part.get("Content-Disposition", "")
        is_attachment = "attachment" in content_disposition.lower()
        if content_type == "text/html" and not is_attachment:
            payload = part.get_payload(decode=True)
            if payload:
                charset = part.get_content_charset() or "utf-8"
                html_body = payload.decode(charset, errors="replace")
        elif content_type == "text/plain" and not is_attachment:
            payload = part.get_payload(decode=True)
            if payload:
                charset = part.get_content_charset() or "utf-8"
                plain_body = payload.decode(charset, errors="replace")
        elif part.get_filename():
            filename = sanitize_filename(decode_str(part.get_filename()) or "attachment")
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            filepath = os.path.join(raw_dir, f"{uid}_{filename}")
            save_file(filepath, payload, dry_run)
            saved_files.append(filepath)
    return html_body, plain_body, saved_files


def search_uids(imap, sender_email: str, since_date: str) -> List[str]:
    criteria = f'(FROM "{sender_email}" SINCE {since_date})'
    status, data = imap.uid("search", None, criteria)
    if status != "OK" or not data or not data[0]:
        return []
    return [uid.decode() for uid in data[0].split()]


# ── Amazon-specific logic ─────────────────────────────────────────────────────
def is_receipt(subject: str) -> bool:
    # Only process Amazon "Shipped" emails — these carry product + amount details.
    return subject.lstrip().lower().startswith("shipped:")


def parse(text: str, subject: str) -> Dict[str, object]:
    """Parse Amazon shipment-confirmation emails (Amazon.in <shipment-tracking@amazon.in>).

    Body layout of a "Shipped:" email (text/plain part), values anonymised:
        Your package was shipped!
        Ordered / Shipped / Out for delivery / Delivered
        Arriving Saturday
        firstname – CITY, STATE
        Order #
        000-0000000-0000000
        Track package ...
        * BRANDNAME - Example Product Description ..., Colour
          Quantity: 1
          549 INR
        Total
        613 INR

    Returns order-level fields plus an "items" list (one dict per product line),
    so the runner can emit one CSV row per item.
    """
    # Order id can be wrapped in RTL/format control chars; match it anywhere.
    order_id = find_first([r"(\d{3}-\d{7}-\d{7})"], text)

    status = "Shipped"

    arriving = find_first([
        r"Arriving\s+([^\r\n]+)",
    ], text)

    # "<name> – CITY, STATE" (en-dash, em-dash or hyphen separator).
    recipient = ""
    location = ""
    addr = re.search(
        r"([A-Za-z][A-Za-z .]*?)\s*[–—-]\s*([A-Z][A-Z]{2,}(?:[ ,]+[A-Z]{2,})*)",
        text,
    )
    if addr:
        recipient = addr.group(1).strip()
        location = addr.group(2).strip()

    # Order total: a "Total" label followed by the amount, e.g. "Total\n613 INR".
    order_total = normalize_amount(find_first([
        r"\bTotal\b\s*\n+\s*([\d,]+(?:\.\d+)?)\s*INR",
        r"\bTotal\b[^\d]{0,20}([\d,]+(?:\.\d+)?)\s*INR",
    ], text))

    # Line items: "* <name>\n  Quantity: N\n  <price> INR"
    items: List[Dict[str, object]] = []
    for m in re.finditer(
        r"\*\s+(.*?)\s*\n\s*Quantity:\s*(\d+)\s*\n\s*([\d,]+(?:\.\d+)?)\s*INR",
        text,
        flags=re.DOTALL,
    ):
        name = re.sub(r"\s+", " ", m.group(1)).strip()
        items.append({
            "product_name": name,
            "quantity": m.group(2),
            "item_price": normalize_amount(m.group(3)),
        })

    return {
        "order_id": order_id,
        "status": status,
        "order_total": order_total,
        "currency": "INR",
        "arriving": arriving,
        "recipient": recipient,
        "location": location,
        "items": items,
    }


# ── Runner ────────────────────────────────────────────────────────────────────
def run(args) -> Tuple[int, int]:
    since_days = args.since_days if args.since_days is not None else DEFAULT_SINCE_DAYS
    search_limit = args.limit if args.limit is not None else SEARCH_LIMIT

    Path(RAW_DIR).mkdir(parents=True, exist_ok=True)
    Path(CSV_PATH).parent.mkdir(parents=True, exist_ok=True)

    if not args.dry_run:
        recreate_if_schema_changed(CSV_PATH, STATE_PATH)

    credentials = load_credentials()
    processed_uids = set(load_state(STATE_PATH))

    try:
        imap = imaplib.IMAP4_SSL("imap.gmail.com")
        imap.login(credentials["email"], credentials["app_password"])
        imap.select("INBOX")
    except Exception as exc:
        logging.error("[%s] Failed to connect/login to IMAP: %s", KEY, exc)
        return 0, 0

    new_count = 0
    total = 0
    try:
        since_str = format_since(since_days)
        logging.info("[%s] Searching since %s", KEY, since_str)
        uids = search_uids(imap, SENDER_EMAIL, since_str)
        if not uids:
            logging.info("[%s] No messages found", KEY)
            return 0, 0

        uids = sorted(uids, key=lambda x: int(x), reverse=True)[:search_limit]

        for uid in sorted(uids, key=lambda x: int(x)):
            total += 1
            if uid in processed_uids:
                continue
            status, data = imap.uid("fetch", uid, "(RFC822)")
            if status != "OK":
                logging.warning("[%s] Failed to fetch UID %s", KEY, uid)
                continue
            msg = email.message_from_bytes(data[0][1])
            subject = decode_str(msg.get("Subject", ""))
            if SUBJECT_PREFIX and not subject.lower().startswith(SUBJECT_PREFIX.lower()):
                continue
            if not is_receipt(subject):
                logging.debug("[%s] UID %s skipped (non-receipt: %s)", KEY, uid, subject[:60])
                continue

            raw_html, raw_plain, attachments = fetch_bodies_and_attachments(msg, RAW_DIR, uid, args.dry_run)
            if raw_html:
                save_file(os.path.join(RAW_DIR, f"{uid}.html"), raw_html.encode("utf-8"), args.dry_run)
            elif not raw_plain:
                logging.warning("[%s] UID %s missing HTML and plain body", KEY, uid)

            # The plain-text part carries clean product/amount lines; prefer it and
            # fall back to text extracted from the HTML body.
            text = raw_plain.strip() or BeautifulSoup(raw_html or "", "html.parser").get_text("\n", strip=True)
            fields = parse(text, subject)
            items = fields.pop("items", []) or [{}]  # at least one row even if no item parsed

            base = {
                **{col: "" for col in COLUMNS},
                **fields,
                "source_sender": KEY,
                "email_uid": uid,
                "email_subject": subject,
                "email_date": parse_email_date(msg.get("Date")),
            }

            rows = []
            for item in items:
                row = dict(base)
                row.update(item)
                rows.append(row)

            if args.dry_run:
                logging.info("[%s] DRY-RUN would append %d row(s) for UID %s", KEY, len(rows), uid)
            else:
                for row in rows:
                    append_csv(CSV_PATH, row)
                processed_uids.add(uid)
                save_state(STATE_PATH, list(processed_uids))
            new_count += 1
            logging.info("[%s] Processed UID %s (items: %d, attachments: %d)", KEY, uid, len(rows), len(attachments))
    finally:
        try:
            imap.logout()
        except Exception:
            pass

    return new_count, total


def main():
    parser = argparse.ArgumentParser(description=f"Fetch {DISPLAY_NAME} invoices from Gmail")
    parser.add_argument("--since-days", type=int, help="Override since-days")
    parser.add_argument("--limit", type=int, help="Max messages to scan")
    parser.add_argument("--dry-run", action="store_true", help="Scan without writing outputs")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s: %(message)s",
    )

    new_count, searched = run(args)
    logging.info("[%s] %s new rows (scanned %s messages)", KEY, new_count, searched)
    return 0


if __name__ == "__main__":
    sys.exit(main())
