# Ana sandbox corpus format (`corpus.json`)

The authored fictional world for the `--profile demo` sandbox (decision 0022).
Read by the demo-seed job (`project/src/entrypoints/demo/`), which feeds every
item through the **real public HTTP API** — never a direct database insert.

## Shape

```jsonc
{
  "persona": { ... },        // documentation only — who's who
  "notes": [
    {
      "id": "en-...",        // stable id (used in logs + assertions)
      "lang": "en" | "hr",   // authored idiomatically, not translated
      "channel": "note" | "chat",
      "daysAgo": 28,          // narrative age; the seed back-dates created_at
                              //   (an UPDATE, never an INSERT) so the world reads
                              //   as weeks of accrual and dormancy/supersession/
                              //   the digest render truthfully
      "role": "...",          // documentation of intent (what this note demonstrates)
      "text": "..."           // the note body, exactly as fed to POST /api/notes
    }
  ],
  "document": {               // the single uploaded PDF — the deletion-receipt object
    "file": "adriatic-foods-consulting-agreement.pdf",
    "title": "...",
    "scope": "private",
    "daysAgo": 22,
    "expectContains": ["..."] // sanity-check strings the extracted text must contain
  }
}
```

## Channels

- **`note`** → `POST /api/notes` (`{ content }`), then poll `GET /api/notes/:id/status`.
- **`chat`** → `POST /api/chat` (`{ content }`, SSE; capture the `done.messageId`),
  then `POST /api/chat/messages/:id/remember` (the explicit "remember this" flow,
  decision 0021), then poll `GET /api/chat/messages/:id/capture-status`.
- **`document`** → `POST /api/files` (multipart `file` + `scope`), then poll
  `GET /api/files/:key/status`.

## Authoring rules

- First-person, as Ana would write: terse, specific, occasionally sloppy. Do not
  write to flatter the extractor — a demo that only works on pristine input
  teaches the wrong lesson.
- Names/entities stay consistent with the golden set (`project/eval/golden`):
  Ana Kovač, Marko, Luka, Marta, Petra, Thomas, Adriatic Foods, Atlas CRM
  Migration, Baltic Retail, Novira.
- Lapsed-validity facts use **absolute past dates** (e.g. "30 June 2026") so
  `outdated` renders regardless of the wall-clock at seed time.
- All fictional. No real person's data (decision 0022 ruling 3).
