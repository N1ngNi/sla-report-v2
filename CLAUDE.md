# CLAUDE.md

A response-time (SLA) report for Bluebay Properties' helpdesk: three sites (Singapore, Sydney,
Jakarta), each with its own timezone, business hours and holidays. The app reads the helpdesk API
and answers "how fast do teams respond, and how often does work finish late" for any date range in
the last six months.

## Sources of truth

Read these before changing behaviour. They win over anything in this file.

- `docs/rules.md`: the seven report rules, with exact field names.
- `docs/contract.md`: endpoints, response shapes, status codes, and how each level is scored.
- `docs/api.md`: the helpdesk API, rate limits and change feed.

Scoring runs against **different data** than the practice API. Every number must come from the
rules, never from the practice data.

## Layout and commands

The app lives in `app/` (Node 22, Express 5, ES modules, `node --test`). Run from the repo root:

```sh
docker compose up --build            # app on http://localhost:8080
docker compose run --rm app test     # tests, exit 0 = pass
```

Without Docker: `cd app && npm test`. Add packages through npm in `app/`, pinned to an exact
version.

Keep these working, the grader depends on them: `docker compose up`, `docker compose run --rm app
test`, port 8080, service name `app`, `HELPDESK_URL` and `HELPDESK_TOKEN` read from the environment.

## Architecture

```
boot    sites + holidays + staff -> replay /v1/changes -> in-memory store -> /ready = true
store   requests by id, events by request id, staff by id
rows    one computed report row per request, recomputed only when that request changes
live    poll /v1/changes every 10 s with the latest cursor; re-read sites, holidays and
        staff every 20 s (the feed has no events for business hours or holidays)
report  filter rows by site-local created date -> aggregate per responder
browse  keyset cursor over (sort value, id), base64 + HMAC so foreign cursors get 400
```

Keep the rules engine **pure**: `(request, events, site, holidays, staff) -> row`, no I/O, no
clock. Everything that touches the network or time lives outside it, so the engine is testable
with fixtures alone.

## Implementing the rules

Each point below is how this codebase applies a rule in `docs/rules.md`, including the edge
cases the doc leaves open. When the data contradicts one of these, change the code, update this
section, and log it in `DECISIONS.md`.

1. **Which requests count.** Convert `created_at` (UTC ISO) to the site's IANA timezone and take
   the local date; keep it when `from <= date <= to`. Drop current status `canceled`, any
   `deleted_at`, any `merged_into_id`. Fetch with a day of margin on each side, since the API's
   `created_from`/`created_to` filter may use a different day boundary.
2. **Undone events.** Build the set of every event id that is either a reverting event (has
   `reverts_id`) or the target of one, and drop that whole set before any other rule runs. A
   revert of a revert drops all three. A `reverts_id` pointing at an unknown event still drops the
   reverting event.
3. **First response.** Among surviving events with `status === "processing"` and a non-null
   `actor_id`, take the smallest `at`, ties broken by smaller `id`. The responder name is the
   current name from staff (kept fresh by `staff.updated`), never `actor_name`.
4. **Business minutes.** Walk site-local calendar days from `created_at` to the response `at`. For
   each day that is open (non-null `business_hours[weekday]`, not a holiday), add the overlap of
   `[open, close)` with the interval, in seconds. Floor the total to minutes. Response before
   `created_at` gives 0. Build each day's open and close instants from wall-clock time in the
   site's IANA zone, never from a fixed offset: Sydney's DST starts on 4 October 2026, inside the
   graded month.
5. **Within target.** Thresholds: `High` 60, `Medium` 240, `Low` or `null` 480 minutes, compared
   with `<=`.
6. **Completed late.** Completion is the surviving `complete` event with the largest `at`.
   Deadline is the `due_at` of the surviving event with the largest `at` that has a non-empty
   `due_at`, parsed as `DD/MM/YYYY HH:mm` in the site's timezone. Late means completion `at` is
   strictly greater than the deadline. The request's `due_on` is never used.
7. **Nulls.** No first response: `responder_id`, `responder`, `response_business_minutes`,
   `within_target` are `null`. No completion or no deadline: `completed_late` is `null`.

Date formats differ by field, so parse each with its own named helper: `created_at` ISO UTC, `at`
Unix seconds, `due_at` `DD/MM/YYYY HH:mm` site-local, holiday `date` and API date params
`DD/MM/YYYY`, our own `from`/`to` `YYYY-MM-DD`.

## Calling the helpdesk API

- The practice data starts changing 5 minutes after the first call. Write fixtures and tests
  first; on the first real call, dump the full change feed to `tmp/` as a snapshot.
- Treat the API as untrusted input: unknown priorities, missing staff, odd `due_at` values and
  duplicate feed items are expected. Handle each one and log it in `DECISIONS.md`.
- On `429`, wait `Retry-After` seconds, then retry. Stay sequential, one request in flight per
  endpoint, so the grader never sees a burst of `429`s.
- On `410` from `/v1/changes` (cursor older than 15 minutes), replay from the start. Apply feed
  items as idempotent upserts by id.
- `HELPDESK_TOKEN` lives only in `.env`, which is git-ignored. Logs and errors print the URL path,
  never the token.

## Testing

Write the test first for every rule and every edge case above, with hand-built fixtures in
`app/test/`. A rule is done when its fixtures cover the normal case and each edge case listed
for it, and `docker compose run --rm app test` exits 0.

## Commits and notes

- Small commits in Conventional Commits style (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), one
  concern each. Reviewers read the history.
- Record every assumption, data surprise, trade-off and AI use in `DECISIONS.md`, in English, as
  it happens.
- `summary.html` is a personal note excluded through `.git/info/exclude`; leave it out of commits.
