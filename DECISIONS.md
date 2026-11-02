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

## How I used AI

<!-- Which tools, what you asked, what came back wrong, what you changed. "I didn't use AI" is fine too. -->

## Trade-offs and what I would do next

<!-- What you left out to stay within 3 hours, and what you would do with more time. -->
