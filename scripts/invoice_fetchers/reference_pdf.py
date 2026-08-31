#!/usr/bin/env python3
# <<OPENBOARD:DOCSTRING>>
"""Standalone Rapido receipt fetcher.

Connects to Gmail over IMAP, finds Rapido receipt emails, extracts attached
PDF ride receipts, and appends one row per unique Ride ID to a per-biller CSV.

Usage:
    python scripts/invoice_fetchers/reference_pdf.py [--since-days N] [--limit N] [--dry-run]

Requires: beautifulsoup4, pdfplumber
Credentials: secrets/gmail_app_credentials.json  -> { "email": ..., "app_password": ... }
"""
# <</OPENBOARD:DOCSTRING>>

import argparse
import csv
import datetime as dt
import email
import imaplib
import io
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

try:
    import pdfplumber
except ImportError:  # pragma: no cover - handled at runtime for clearer CLI logs
    pdfplumber = None


REPO_ROOT = Path(__file__).resolve().parents[2]
CREDENTIALS_PATH = REPO_ROOT / "secrets" / "gmail_app_credentials.json"

# <<OPENBOARD:CONFIG>>
KEY = "rapido"
DISPLAY_NAME = "Rapido"
SENDER_EMAIL = "partner@rapido.bike"
SUBJECT_PREFIX = ""
CSV_PATH = REPO_ROOT / "data" / "invoices" / "rapido.csv"
RAW_DIR = REPO_ROOT / "data" / "invoices" / "raw" / "rapido"
STATE_PATH = RAW_DIR / "state.json"
DEFAULT_SINCE_DAYS = 365
SEARCH_LIMIT = 1000
# <</OPENBOARD:CONFIG>>

# <<OPENBOARD:COLUMNS>>
COLUMNS = [
    "source_sender",
    "email_uid",
    "email_subject",
    "email_date",
    "ride_id",
    "customer_name",
    "driver",
    "vehicle_number",
    "vehicle_mode",
    "ride_datetime",
    "pickup",
    "dropoff",
    "selected_price",
    "total_paid",
    "payment_method",
    "currency",
    "receipt_file",
]
# <</OPENBOARD:COLUMNS>>


def read_json(path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_credentials() -> dict:
    """Gmail IMAP credentials, preferring the environment over the disk.

    OpenBoardCLI passes OPENBOARD_GMAIL_EMAIL and OPENBOARD_GMAIL_APP_PASSWORD to
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
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        with open(path, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            header = reader.fieldnames or []
            if header == COLUMNS:
                return
            rows = list(reader)
        backup = f"{path}.bak"
        temporary = f"{path}.tmp"
        with open(temporary, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=COLUMNS)
            writer.writeheader()
            writer.writerows({column: row.get(column, "") for column in COLUMNS} for row in rows)
        if os.path.exists(backup):
            os.remove(backup)
        os.replace(path, backup)
        os.replace(temporary, path)
        logging.info("[%s] CSV schema changed; archived the old file to %s", KEY, backup)
        return
    with open(path, "w", newline="", encoding="utf-8") as f:
        csv.DictWriter(f, fieldnames=COLUMNS).writeheader()


def existing_ride_ids(path) -> set[str]:
    if not os.path.exists(path):
        return set()
    with open(path, "r", newline="", encoding="utf-8") as f:
        return {row.get("ride_id", "").strip() for row in csv.DictReader(f) if row.get("ride_id")}


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


def _search_uids(imap, criteria: str) -> List[str]:
    status, data = imap.uid("search", None, criteria)
    if status != "OK" or not data or not data[0]:
        return []
    return [uid.decode() for uid in data[0].split()]


def search_uids(imap, sender_email, since_date: str) -> List[str]:
    """UIDs to consider, widening the search when the sender match finds nothing.

    A FROM search cannot see a forwarded receipt: forwarding rewrites the From:
    header to whoever forwarded it, leaving the original sender only in the
    quoted body. TEXT searches headers and body together, so it still finds the
    receipt inside a forwarded thread.

    The sender match runs first and wins outright when it matches, so an inbox
    receiving mail directly is unaffected. Accepts one address or several.
    """
    senders = sender_email if isinstance(sender_email, (list, tuple, set)) else [sender_email]

    uids = set()
    for sender in senders:
        uids.update(_search_uids(imap, f'(FROM "{sender}" SINCE {since_date})'))
    if uids:
        return sorted(uids, key=lambda value: int(value))

    # Nothing from that sender directly — look for it quoted in forwarded mail.
    for sender in senders:
        uids.update(_search_uids(imap, f'(SINCE {since_date} TEXT "{sender}")'))
    return sorted(uids, key=lambda value: int(value))


# <<OPENBOARD:IS_RECEIPT>>
def is_receipt(subject: str) -> bool:
    lowered = subject.lower()
    return "rapido" in lowered or "trip with rapido" in lowered
# <</OPENBOARD:IS_RECEIPT>>


# <<OPENBOARD:EXTRACT_PDF_TEXT>>
def extract_pdf_text(data: bytes) -> str:
    if pdfplumber is None:
        raise RuntimeError("pdfplumber is required to parse Rapido PDF receipts")
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        return "\n".join(page.extract_text(layout=True) or "" for page in pdf.pages)
# <</OPENBOARD:EXTRACT_PDF_TEXT>>


# <<OPENBOARD:PARSE_RECEIPT>>
def parse_receipt(text: str) -> Dict[str, str]:
    normalized = re.sub(r"\r\n?", "\n", text)
    raw_lines = [line.strip() for line in normalized.splitlines()]

    customer_name = find_first([r"Customer\s+Name\s+(.+)"], normalized)
    ride_id = find_first([r"Ride\s+ID\s+(RD\d+)"], normalized)
    driver = find_first([r"Driver\s+name\s+(.+)"], normalized)
    vehicle_number = find_first([r"Vehicle\s+Number\s+([A-Z0-9 -]+)"], normalized)
    vehicle_mode = find_first([r"Mode\s+of\s+Vehicle\s+(.+)"], normalized)
    ride_datetime = find_first([r"Time\s+of\s+Ride\s+(.+)"], normalized)
    selected_price = normalize_amount(find_first([
        r"Selected\s+Price\s*\n\s*(?:\u20b9|Rs\.?)\s*([0-9.,]+)",
        r"Selected\s+Price\s*(?:\u20b9|Rs\.?)\s*([0-9.,]+)",
    ], normalized))

    pickup, dropoff = extract_locations(raw_lines)

    return {
        "ride_id": ride_id,
        "customer_name": customer_name,
        "driver": driver,
        "vehicle_number": vehicle_number,
        "vehicle_mode": vehicle_mode,
        "ride_datetime": ride_datetime,
        "pickup": pickup,
        "dropoff": dropoff,
        "selected_price": selected_price,
        "total_paid": selected_price,
        "payment_method": "",
        "currency": "INR",
    }
# <</OPENBOARD:PARSE_RECEIPT>>


# <<OPENBOARD:EXTRACT_LOCATIONS>>
def extract_locations(lines: List[str]) -> Tuple[str, str]:
    try:
        price_index = next(i for i, line in enumerate(lines) if re.fullmatch(r"(?:\u20b9|Rs\.?)?\s*[0-9.,]+", line))
    except StopIteration:
        return "", ""

    disclaimer_markers = (
        "This document is issued",
        "*Selected Price refers",
        "Rapido does not collect",
    )
    groups: List[List[str]] = []
    current: List[str] = []
    for line in lines[price_index + 1:]:
        if not line:
            if current:
                groups.append(current)
                current = []
            continue
        if any(line.startswith(marker) for marker in disclaimer_markers):
            break
        current.append(line)
    if current:
        groups.append(current)

    address_groups = [" ".join(group).strip() for group in groups if " ".join(group).strip()]
    if len(address_groups) < 2:
        return (address_groups[0] if address_groups else "", "")

    return address_groups[0], address_groups[1]
# <</OPENBOARD:EXTRACT_LOCATIONS>>


# <<OPENBOARD:FETCH_PARTS>>
def fetch_parts(msg, raw_dir, uid: str, dry_run: bool) -> Tuple[str, List[Tuple[str, bytes, str]]]:
    html_body = ""
    pdfs = []
    for part in msg.walk():
        content_type = part.get_content_type()
        content_disposition = part.get("Content-Disposition", "")
        filename = part.get_filename()

        if content_type == "text/html" and "attachment" not in content_disposition.lower():
            payload = part.get_payload(decode=True)
            if payload:
                charset = part.get_content_charset() or "utf-8"
                html_body = payload.decode(charset, errors="replace")
            continue

        if not filename:
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        safe_name = sanitize_filename(decode_str(filename) or "attachment")
        filepath = os.path.join(raw_dir, f"{uid}_{safe_name}")
        save_file(filepath, payload, dry_run)
        if content_type == "application/pdf" or safe_name.lower().endswith(".pdf"):
            pdfs.append((safe_name, payload, filepath))

    return html_body, pdfs
# <</OPENBOARD:FETCH_PARTS>>


def run(args) -> Tuple[int, int]:
    since_days = args.since_days if args.since_days is not None else DEFAULT_SINCE_DAYS
    search_limit = args.limit if args.limit is not None else SEARCH_LIMIT

    Path(RAW_DIR).mkdir(parents=True, exist_ok=True)
    Path(CSV_PATH).parent.mkdir(parents=True, exist_ok=True)

    credentials = load_credentials()
    processed_uids = set(load_state(STATE_PATH))
    known_ride_ids = existing_ride_ids(CSV_PATH)

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

            raw_html, pdfs = fetch_parts(msg, RAW_DIR, uid, args.dry_run)
            if raw_html:
                save_file(os.path.join(RAW_DIR, f"{uid}.html"), raw_html.encode("utf-8"), args.dry_run)

            appended_for_uid = 0
            for filename, payload, filepath in pdfs:
                try:
                    text = extract_pdf_text(payload)
                except Exception as exc:
                    logging.warning("[%s] Failed to parse PDF %s on UID %s: %s", KEY, filename, uid, exc)
                    continue

                fields = parse_receipt(text)
                ride_id = fields.get("ride_id", "")
                if ride_id and ride_id in known_ride_ids:
                    continue

                row = {
                    **{col: "" for col in COLUMNS},
                    **fields,
                    "source_sender": KEY,
                    "email_uid": uid,
                    "email_subject": subject,
                    "email_date": parse_email_date(msg.get("Date")),
                    "receipt_file": os.path.relpath(filepath, REPO_ROOT),
                }

                if args.dry_run:
                    logging.info("[%s] DRY-RUN would append row for UID %s receipt %s", KEY, uid, filename)
                else:
                    append_csv(CSV_PATH, row)
                    if ride_id:
                        known_ride_ids.add(ride_id)
                new_count += 1
                appended_for_uid += 1

            if not args.dry_run:
                processed_uids.add(uid)
                save_state(STATE_PATH, list(processed_uids))
            logging.info("[%s] Processed UID %s (%d new receipts, %d PDFs)", KEY, uid, appended_for_uid, len(pdfs))
    finally:
        try:
            imap.logout()
        except Exception:
            pass

    return new_count, total


def main():
    parser = argparse.ArgumentParser(description=f"Fetch {DISPLAY_NAME} receipts from Gmail")
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
