You are analysing one receipt/invoice email so OpenBoard can build a fetcher for it.

The text below is the email body after `BeautifulSoup(html, "html.parser").get_text("\n", strip=True)`. That means every visual element became its own line, so **a label and its value are usually on separate lines**. Any regex you propose later must account for that.

Your job is to decide what a fetcher should extract from emails like this one, and to return it as JSON.

## Output format

Return ONLY a JSON object between `//JSON_START` and `//JSON_END`. No prose outside those markers.

```
//JSON_START
{
  "key": "lower_snake_case identifier, e.g. big_basket",
  "displayName": "Human readable name, e.g. BigBasket",
  "senderEmail": "the address these emails come from",
  "subjectPrefix": "a literal prefix the subject starts with, or \"\" if subjects vary",
  "subjectKeywords": ["lowercase", "words", "identifying", "a", "receipt"],
  "defaultSinceDays": 30,
  "searchLimit": 100,
  "fields": [
    {
      "name": "order_id",
      "description": "The order identifier",
      "example": "the literal value found in this email",
      "type": "string | amount | datetime"
    }
  ],
  "notes": "One sentence on anything unusual — PDF attachments, several rows per email, multiple senders."
}
//JSON_END
```

## Rules

1. `key` must match `^[a-z][a-z0-9_]*$` and describe the biller, not the email. It becomes the CSV filename and the dashboard selector.
2. `subjectPrefix` only when subjects reliably start with a fixed string. If they vary, use `""` and rely on `subjectKeywords`.
3. `subjectKeywords` must be lowercase and specific enough to exclude marketing mail from the same sender. This is the difference between a fetcher that collects receipts and one that collects newsletters.
4. Propose fields that are **actually present in this email**. Do not invent a `tip` or `discount` field because similar billers have one — every field you list will become a regex that has to match.
5. Mark money fields as `"type": "amount"`; they will be run through `normalize_amount()` and stored as numbers.
6. Mark timestamps as `"type": "datetime"`.
7. `example` must be copied verbatim from the email — it is what the regex gets tested against.
8. Do NOT include `source_sender`, `email_uid`, `email_subject`, `email_date`, or `currency`. Those are added automatically.
9. Aim for 4–12 fields. A fetcher that captures the total, the identifier, and the line items is more useful than one that captures thirty brittle fields.
10. Tune `defaultSinceDays` / `searchLimit` to how often these arrive: frequent consumer orders 30/100, occasional bills 90/200, rare archival receipts 365/1000.
