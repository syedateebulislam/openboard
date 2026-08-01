#!/usr/bin/env python3
"""Exercise probe_biller.py's text extraction without touching a mailbox.

Builds email messages in memory and runs the real extract_body_text() and
matches_subject() over them, printing results as JSON for the vitest suite.
This is the layer the live runs cover incidentally; here it is pinned.

Usage: python probe_extract_check.py <path to probe_biller.py>
"""

import importlib.util
import json
import sys
from email.message import EmailMessage


def load(path):
    spec = importlib.util.spec_from_file_location("probe_biller", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def html_message() -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = "Your order"
    msg.set_content("plain text fallback")
    msg.add_alternative(
        "<html><body><p>Order ID</p><p>BB-1</p><p>Total</p><p>418.50</p></body></html>",
        subtype="html",
    )
    return msg


def plain_only_message() -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = "Your order"
    msg.set_content("Order ID\nBB-2\nTotal\n99.00")
    return msg


def empty_message() -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = "Nothing here"
    return msg


def with_fake_pdf() -> EmailMessage:
    """A PDF part whose bytes are not a real PDF.

    extract_pdf_text() must swallow the failure and fall back to the HTML body
    rather than propagating an exception out of the probe.
    """
    msg = html_message()
    msg.add_attachment(b"not really a pdf", maintype="application", subtype="pdf", filename="receipt.pdf")
    return msg


def main() -> int:
    probe = load(sys.argv[1])
    results = {}

    text, source = probe.extract_body_text(html_message())
    results["html"] = {"source": source, "hasOrderId": "Order ID" in text, "hasValue": "BB-1" in text}

    text, source = probe.extract_body_text(plain_only_message())
    results["plain"] = {"source": source, "hasValue": "BB-2" in text}

    text, source = probe.extract_body_text(empty_message())
    results["empty"] = {"source": source, "textLen": len(text.strip())}

    text, source = probe.extract_body_text(with_fake_pdf())
    results["unreadablePdf"] = {"source": source, "hasValue": "BB-1" in text}

    results["attachments"] = probe.attachment_names(with_fake_pdf())

    results["subjectFilter"] = {
        "emptyMatchesAll": probe.matches_subject("anything at all", ""),
        "caseInsensitive": probe.matches_subject("YOUR ORDER from X", "your order"),
        "substringAnywhere": probe.matches_subject("Re: Your order", "Your order"),
        "rejectsMismatch": probe.matches_subject("Newsletter", "Your order"),
    }

    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
