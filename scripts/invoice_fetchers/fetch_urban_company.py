#!/usr/bin/env python3
"""Standalone Urban Company invoice fetcher.

Self-contained: connects to Gmail over IMAP, finds Urban Company payment emails,
parses order details, and appends them to a per-biller CSV. No dependency on any
other script. Tune the regexes in parse() to match Urban Company's real mail body.

Usage:
    python scripts/invoice_fetchers/fetch_urban_company.py [--since-days N] [--limit N] [--dry-run]

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

KEY = "urban_company"
DISPLAY_NAME = "Urban Company (UrbanClap)"
SENDER_EMAIL = "payment@urbancompany.com"
SUBJECT_PREFIX = "Payment Summary"
CSV_PATH = REPO_ROOT / "data" / "invoices" / "urban_company.csv"
RAW_DIR = REPO_ROOT / "data" / "invoices" / "raw" / "urban_company"
STATE_PATH = RAW_DIR / "state.json"
DEFAULT_SINCE_DAYS = 30
SEARCH_LIMIT = 100

COLUMNS = [
    "source_sender",
    "email_uid",
    "email_subject",
    "email_date",
    "service_charges",
    "subtotal",
    "discount",
    "net_total",
    "amount_paid",
    "amount_due",
    "payment_method",
    "currency",
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


def fetch_html_and_attachments(msg, raw_dir, uid: str, dry_run: bool) -> Tuple[str, List[str]]:
    html_body = ""
    saved_files = []
    for part in msg.walk():
        content_type = part.get_content_type()
        content_disposition = part.get("Content-Disposition", "")
        if content_type == "text/html" and "attachment" not in content_disposition.lower():
            payload = part.get_payload(decode=True)
            if payload:
                charset = part.get_content_charset() or "utf-8"
                html_body = payload.decode(charset, errors="replace")
        elif part.get_filename():
            filename = sanitize_filename(decode_str(part.get_filename()) or "attachment")
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            filepath = os.path.join(raw_dir, f"{uid}_{filename}")
            save_file(filepath, payload, dry_run)
            saved_files.append(filepath)
    return html_body, saved_files


def search_uids(imap, sender_email: str, since_date: str) -> List[str]:
    criteria = f'(FROM "{sender_email}" SINCE {since_date})'
    status, data = imap.uid("search", None, criteria)
    if status != "OK" or not data or not data[0]:
        return []
    return [uid.decode() for uid in data[0].split()]


# ── Urban Company-specific logic ────────────────────────────────────────────────
def is_receipt(subject: str) -> bool:
    return True  # subject-prefix filter is enough


def parse(text: str, subject: str) -> Dict[str, str]:
    """Parse Urban Company payment-summary emails (payment@urbancompany.com).

    Body layout (from a summary) — amounts have NO ₹ symbol:
        Payment summary
        Service Charges        536
        Subtotal               536
        Total Discounts        0
        Net Total              536
        Amount Already Paid (Online Payment)   536
        Amount To Be Paid      0
    """
    service_charges = normalize_amount(find_first([
        r"Service\s*Charges?\s*\n\s*([0-9.,]+)",
    ], text))

    subtotal = normalize_amount(find_first([
        r"Subtotal\s*\n\s*([0-9.,]+)",
    ], text))

    discount = normalize_amount(find_first([
        r"Total\s*Discounts?\s*\n\s*([0-9.,]+)",
        r"Discounts?\s*\n\s*([0-9.,]+)",
    ], text))

    net_total = normalize_amount(find_first([
        r"Net\s*Total\s*\n\s*([0-9.,]+)",
    ], text))

    # "Amount Already Paid (Online Payment)\n536" -> method + amount.
    payment_method = ""
    amount_paid = ""
    paid = re.search(
        r"Amount\s*Already\s*Paid\s*(?:\(([^)]+)\))?\s*\n\s*([0-9.,]+)", text, re.IGNORECASE)
    if paid:
        payment_method = (paid.group(1) or "").strip()
        amount_paid = normalize_amount(paid.group(2))

    amount_due = normalize_amount(find_first([
        r"Amount\s*To\s*Be\s*Paid\s*\n\s*([0-9.,]+)",
    ], text))

    return {
        "service_charges": service_charges,
        "subtotal": subtotal,
        "discount": discount,
        "net_total": net_total,
        "amount_paid": amount_paid,
        "amount_due": amount_due,
        "payment_method": payment_method,
        "currency": "INR",
    }


# ── Runner ────────────────────────────────────────────────────────────────────
def run(args) -> Tuple[int, int]:
    since_days = args.since_days if args.since_days is not None else DEFAULT_SINCE_DAYS
    search_limit = args.limit if args.limit is not None else SEARCH_LIMIT

    Path(RAW_DIR).mkdir(parents=True, exist_ok=True)
    Path(CSV_PATH).parent.mkdir(parents=True, exist_ok=True)

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

            raw_html, attachments = fetch_html_and_attachments(msg, RAW_DIR, uid, args.dry_run)
            if raw_html:
                save_file(os.path.join(RAW_DIR, f"{uid}.html"), raw_html.encode("utf-8"), args.dry_run)
            else:
                logging.warning("[%s] UID %s missing HTML body", KEY, uid)

            text = BeautifulSoup(raw_html or "", "html.parser").get_text("\n", strip=True)
            fields = parse(text, subject)
            row = {
                **{col: "" for col in COLUMNS},
                **fields,
                "source_sender": KEY,
                "email_uid": uid,
                "email_subject": subject,
                "email_date": parse_email_date(msg.get("Date")),
            }

            if args.dry_run:
                logging.info("[%s] DRY-RUN would append row for UID %s", KEY, uid)
            else:
                append_csv(CSV_PATH, row)
                processed_uids.add(uid)
                save_state(STATE_PATH, list(processed_uids))
            new_count += 1
            logging.info("[%s] Processed UID %s (attachments: %d)", KEY, uid, len(attachments))
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
