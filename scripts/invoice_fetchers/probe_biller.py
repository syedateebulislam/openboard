#!/usr/bin/env python3
"""Sample one email so OpenBoard can learn a new biller.

Not a fetcher. This script writes no CSV and keeps no state — it connects to
Gmail, finds messages from a sender (optionally narrowed by subject), and
prints ONE decoded sample as JSON on stdout. Biller Studio feeds that sample to
an LLM, which proposes the fields a real fetcher should extract.

The filename deliberately does not start with "fetch_", so discoverBillers
ignores it and it never shows up as a biller in the UI.

The text emitted here is produced exactly the way a real fetcher produces it —
BeautifulSoup(...).get_text("\\n", strip=True) — so regexes written against this
sample will match at fetch time.

Usage:
    python scripts/invoice_fetchers/probe_biller.py --sender noreply@example.com
        [--subject "Your order"] [--since-days N] [--max-chars N]

Requires: beautifulsoup4
Credentials: OPENBOARD_GMAIL_EMAIL / OPENBOARD_GMAIL_APP_PASSWORD in the
environment, falling back to secrets/gmail_app_credentials.json
"""

import argparse
import datetime as dt
import email
import imaplib
import io
import json
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
except ImportError:  # pragma: no cover - reported at runtime for clearer logs
    pdfplumber = None

# ── Probe config ─────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parents[2]
CREDENTIALS_PATH = REPO_ROOT / "secrets" / "gmail_app_credentials.json"

DEFAULT_SINCE_DAYS = 365
DEFAULT_MAX_CHARS = 8000
# How many other subjects to report, so the user can tell whether their filter
# is too broad without us shipping a second full body anywhere.
SUBJECT_SAMPLE_LIMIT = 5


# ── Shared helpers (inlined so this script stands alone) ──────────────────────
def read_json(path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_credentials() -> dict:
    """Gmail IMAP credentials, preferring the environment over the disk.

    OpenBoard passes OPENBOARD_GMAIL_EMAIL and OPENBOARD_GMAIL_APP_PASSWORD to
    this process so the App Password never has to be written to a file. Running
    the script by hand still works: it falls back to the credentials JSON the
    fetchers have always read.
    """
    email_address = os.environ.get("OPENBOARD_GMAIL_EMAIL")
    app_password = os.environ.get("OPENBOARD_GMAIL_APP_PASSWORD")
    if email_address and app_password:
        return {"email": email_address, "app_password": app_password}
    return read_json(CREDENTIALS_PATH)


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


# ── Probe-specific logic ─────────────────────────────────────────────────────
def extract_pdf_text(data: bytes) -> str:
    """Text of a PDF receipt, laid out the way fetch_rapido.py reads them."""
    if pdfplumber is None:
        return ""
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return "\n".join(page.extract_text(layout=True) or "" for page in pdf.pages)
    except Exception:
        return ""


def extract_body_text(msg) -> Tuple[str, str]:
    """Decoded body plus which source it came from.

    HTML is preferred, then plain text, then PDF attachments — some billers
    (Rapido, for one) send an almost empty body and put the whole receipt in an
    attached PDF. Without the PDF branch the model would be asked to write
    regexes against nothing.
    """
    html_body = ""
    plain_body = ""
    pdf_text = ""

    for part in msg.walk():
        content_type = part.get_content_type()
        disposition = part.get("Content-Disposition", "")
        payload = part.get_payload(decode=True)
        if not payload:
            continue

        filename = part.get_filename() or ""
        is_pdf = content_type == "application/pdf" or filename.lower().endswith(".pdf")
        if is_pdf:
            if not pdf_text:
                pdf_text = extract_pdf_text(payload)
            continue

        if "attachment" in disposition.lower():
            continue

        charset = part.get_content_charset() or "utf-8"
        decoded = payload.decode(charset, errors="replace")
        if content_type == "text/html" and not html_body:
            html_body = decoded
        elif content_type == "text/plain" and not plain_body:
            plain_body = decoded

    body = ""
    source = "none"
    if html_body:
        body = BeautifulSoup(html_body, "html.parser").get_text("\n", strip=True)
        source = "html"
    elif plain_body.strip():
        body = plain_body.strip()
        source = "text"

    # A body of a few words next to a real PDF means the receipt is in the PDF.
    if pdf_text and len(pdf_text.strip()) > len(body.strip()):
        return pdf_text.strip(), "pdf"

    if not body and pdf_text:
        return pdf_text.strip(), "pdf"

    return body, source


def attachment_names(msg) -> List[str]:
    names = []
    for part in msg.walk():
        filename = part.get_filename()
        if filename:
            names.append(decode_str(filename))
    return names


def matches_subject(subject: str, subject_filter: str) -> bool:
    if not subject_filter:
        return True
    return subject_filter.lower() in subject.lower()


def probe(args) -> Dict:
    credentials = load_credentials()

    imap = imaplib.IMAP4_SSL("imap.gmail.com")
    try:
        imap.login(credentials["email"], credentials["app_password"])
        imap.select("INBOX")

        since_str = format_since(args.since_days)
        uids = search_uids(imap, args.sender, since_str)
        if not uids:
            return {
                "matched": 0,
                "scanned": 0,
                "sample": None,
                "otherSubjects": [],
                "sinceDate": since_str,
            }

        # Newest first: the most recent email is the most likely to reflect the
        # sender's current template, which is what the regexes must match.
        uids = sorted(uids, key=lambda value: int(value), reverse=True)

        sample = None
        other_subjects: List[str] = []
        matched = 0
        scanned = 0

        for uid in uids[: args.scan_limit]:
            scanned += 1
            status, data = imap.uid("fetch", uid, "(RFC822)")
            if status != "OK" or not data or not data[0]:
                continue
            msg = email.message_from_bytes(data[0][1])
            subject = decode_str(msg.get("Subject", ""))
            if not matches_subject(subject, args.subject):
                continue

            matched += 1
            if sample is None:
                body, body_source = extract_body_text(msg)
                sample = {
                    "uid": uid,
                    "subject": subject,
                    "date": parse_email_date(msg.get("Date")),
                    "from": decode_str(msg.get("From", "")),
                    "attachments": attachment_names(msg),
                    # "html" | "text" | "pdf" | "none" — the generator needs to
                    # know, because a PDF biller needs a different skeleton.
                    "bodySource": body_source,
                    "pdfSupport": pdfplumber is not None,
                    "text": body[: args.max_chars],
                    "truncated": len(body) > args.max_chars,
                    "fullLength": len(body),
                }
            elif len(other_subjects) < SUBJECT_SAMPLE_LIMIT:
                other_subjects.append(subject)

        return {
            "matched": matched,
            "scanned": scanned,
            "sample": sample,
            "otherSubjects": other_subjects,
            "sinceDate": since_str,
        }
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="Sample one email for a prospective biller")
    parser.add_argument("--sender", required=True, help="Sender email address to search for")
    parser.add_argument("--subject", default="", help="Optional substring the subject must contain")
    parser.add_argument("--since-days", type=int, default=DEFAULT_SINCE_DAYS)
    parser.add_argument("--scan-limit", type=int, default=40, help="Max messages to open")
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    args = parser.parse_args()

    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", args.sender):
        # Printed as JSON too, so the caller only ever parses one shape.
        print(json.dumps({"error": f"Not a valid email address: {args.sender}"}))
        return 2

    try:
        result = probe(args)
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI as JSON
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1

    # stdout is the machine-readable channel; nothing else may be printed here.
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
