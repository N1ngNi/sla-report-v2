# DECISIONS

Write in English. Short bullet points are fine. Reviewers read this file alongside your code.

## What I assumed

<!-- Anything the brief did not say that you had to decide. -->

- **Reverts (rule 2):** I drop every event that has `reverts_id` and every event it points at,
  before applying any other rule. A revert of a revert therefore drops all three events: the
  rule says "ignore both", and I applied that literally instead of guessing that the original
  event comes back. A `reverts_id` pointing at an event we don't have still drops the reverting
  event.
- **Ordering:** events are ordered by `at`; events at the same second fall back to `id`. This
  decides the first response, the last completion and the latest deadline.
- **Responder name (rule 3):** the current name from `/v1/staff`. If the actor is missing from
  staff, I fall back to the event's `actor_name` rather than showing no name.
- **Priority (rule 5):** matched case-insensitively. Any value other than High/Medium/Low gets
  the 480-minute target, the same as `null`.
- **Deadline (rule 6):** an empty or unparseable `due_at` is treated as "this event set no
  deadline", so the latest *valid* one wins. `due_on` on the request is never used, as the rule
  says.
- **Business hours (rule 4):** time is summed per site-local calendar day using the site's IANA
  timezone, so DST (Sydney switches on 4 Oct 2026, inside the graded month) is handled. A
  `close` of `24:00` means midnight. A missing or `null` weekday means closed.

## What I found in the API or data

<!-- Anything that did not match the docs, or surprised you, and how you handled it. -->

From a full dump of the practice API on 2 Nov (79,590 feed items, 11,986 requests, 45,849
events), checked with a throwaway analysis script:

- **Rate limit is tight.** Paging `/v1/changes` back-to-back hit `429` on roughly every fifth
  call (28 of 201), always with `Retry-After: 1`. Waiting it out works, but the brief scores
  "not flooding the API into 429s", so the app paces its own calls instead of relying on 429s.
- **The feed redelivers items.** 318 items arrived twice, some out of `seq` order; the copies
  were identical. The store applies items as upserts by id, so replaying one is harmless.
- **Events are append-only.** No event was ever changed; undoing is done by a new event with
  `reverts_id` (195 of them, all pointing at an earlier event of the same request, no chains in
  this data). Rule 2 still handles chains in case the graded data has them.
- **`request` in the feed is the current version**, as documented: every copy of a request in
  the dump was identical. So the latest copy of each request is enough.
- **`actor_name` goes stale.** 971 events carry an old name for a staff member who still exists
  (one `staff.updated` in the feed). The report uses `/v1/staff` names, as rule 3 requires.
- **A response before creation exists.** Request 63467 has a `processing` event ~4 seconds before
  its `created_at`; rule 4 makes that 0 minutes, which is covered by a test.
- **Sydney has a public holiday on Mon 5 Oct**, the first working day after its DST switch, so
  both are exercised by the October range.
- The feed matched `/v1/requests` and `/v1/requests/{id}/events` exactly on the sample compared.
  Reading events per request would cost ~12,000 calls, so the app reads only the change feed.

## How I used AI

<!-- Which tools, what you asked, what came back wrong, what you changed. "I didn't use AI" is fine too. -->

I used Claude Code (Claude Opus) as a pair programmer throughout.

- **Reading the brief.** I had it summarise the rules, contract and API, then list where the
  rules are ambiguous. That list became the "What I assumed" section and the edge-case tests.
- **Project rules.** `CLAUDE.md` holds the rules, the architecture and the conventions, so every
  AI session works from the same spec instead of re-deriving it.
- **Tests first.** For the time and rules modules, tests were written and seen failing before
  the code. Hand-built fixtures cover each rule's edge cases (DST, holidays, revert chains,
  reopened requests and so on).
- **Checking against real data.** Before wiring anything up, it dumped the API to `tmp/` and ran
  throwaway analysis scripts. Those found the duplicate feed items, the rate limit and the stale
  actor names. I also hand-checked a few computed rows against the raw events.
- **What it got wrong, and what changed.**
  - Two test expectations were wrong: a key-sort order, and a fixture default it overlooked.
    Caught by running the tests.
  - The first live check showed no change in 45 s. Instead of assuming the sync worked, it read
    the feed directly, found the data changes in small batches, and added a log line per poll
    to prove updates land.
  - A plain keyset cursor would skip or repeat a row whose response time changes mid-walk, for
    example when it gets its first response. Paging from a snapshot fixed that, and a test
    covers it.

## Client requests

- **CSV export (2 Nov, 17:36 SGT).** Finance wanted the browse list in Excel monthly. Added
  `GET /api/requests.csv` and a "Download CSV" link on the browse page.
  - It reuses the same parameter validation, filtering and sorting code as `/api/requests`, so
    the two can't drift apart. Invalid filters or sort give `400`.
  - `limit` and `cursor` are ignored entirely, as requested, so even a stale cursor doesn't
    fail the download.
  - It reads the live rows; one download is a single request, so no snapshot is needed.
  - Quoting follows RFC 4180: a field is quoted when it has a comma, quote or line break, and
    quotes are doubled. Booleans are `true`/`false`, `null` is an empty field.
  - Lines end in `\n`. There is no UTF-8 BOM, so the first line is exactly the specified
    header. Current staff names are ASCII; if non-ASCII names appeared, Excel may need the
    BOM, which I'd confirm with the client before adding.

## Trade-offs and what I would do next

<!-- What you left out to stay within 3 hours, and what you would do with more time. -->

- **In memory, no database.** About 12,000 requests and 46,000 events fit easily in memory, and
  the six-month report is a filter over precomputed rows (~50 ms). The cost is that a restart
  re-reads the whole feed, which takes about a minute (`/ready` is 503 meanwhile). Next step:
  persist the store and the feed cursor (SQLite or a JSON file) so a restart only catches up.
- **Live updates by polling** the change feed every 10 s, well inside the 60 s target. Calls are
  spaced 300 ms apart: the initial load took 165 calls and ~53 s with zero `429`s.
- **Business time: simple first, then measured and optimised.** The first version walked every
  local day between creation and response, building that day's opening hours with Luxon,
  because it maps one-to-one onto rule 4 and is easy to check. A profile then showed ~77% of a
  full recompute (~2.9 s for 11,150 rows) was spent rebuilding the same days' hours over and
  over. It now uses a per-site *business clock*: open windows built once per local day, each
  with the business seconds accumulated before it. Business time is `clock(end) - clock(start)`,
  found with two binary searches. Together with parsing deadlines only for completed requests,
  a full recompute takes ~0.36 s (8x faster), and a staff reload ~37 ms instead of ~2.9 s
  (only rows whose responder was renamed are recomputed). Every row came out identical to the
  old version on the full practice dataset, and the original time tests are unchanged.
- **Reference data** (sites, holidays, staff) is re-read every **20 s**. A self-review found a
  gap here: the change feed carries staff renames but **not** business-hours or holiday
  changes. With the original 5-minute reload, such a change could take minutes to show,
  against level 3's 60 s.
  - At 20 s the worst case is about 30 s (reload interval plus one 10 s poll).
  - The cost is 5 calls per reload, ~0.27 calls/s with feed polling, well under the observed
    limit.
  - Lists are compared in a canonical order (sorted by id or date), so a reordered response
    doesn't trigger a needless full recompute.
  - A real site or holiday change recomputes every row (~0.4 s, blocking the event loop
    briefly). A staff change recomputes only that person's rows.
  - At 10x the data, the bottleneck becomes the rate-limited initial feed replay (~8 min), so
    the next step there is persisting the store and feed cursor.
- **Browsing** reads from snapshots of the rows (the last 50 versions). A walk that outlives its
  snapshot falls back to keyset paging over live rows, which is still correct for rows whose
  sort value doesn't change. Cursors are signed with a per-process secret unless `CURSOR_SECRET`
  is set, so a restart invalidates old cursors (they get `400`).
- **Front end:** two plain HTML pages, a report with site and responder summaries and a browse
  page, with no build step. Polish was out of scope.
- **Explaining 0-minute responses.** In October about 43% of answered requests score 0 business
  minutes, almost all because they were answered outside opening hours (e.g. created 01:46,
  answered 06:47, before an 08:00 opening). The API keeps the exact contract shape. Our pages
  ask for `?details=true`, which adds `response_elapsed_minutes` and `response_note`, so a 0 is
  shown as "answered outside business hours, 5 h 0 m after creation". The site table gains an
  "answered outside hours" column. That is arguably the most useful number for the director:
  a large share of requests is handled before the clock starts.
- **With more time:** an end-to-end test that replays a recorded feed through the HTTP API,
  metrics on sync lag, and asking the client how "within target" should treat requests that
  never got a response (they are `null` today, as rule 7 says, and so count as neither).
