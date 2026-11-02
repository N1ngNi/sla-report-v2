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

## Trade-offs and what I would do next

<!-- What you left out to stay within 3 hours, and what you would do with more time. -->
