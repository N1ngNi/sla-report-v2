// The seven report rules from docs/rules.md as pure functions: no I/O, no clock.
import { parseIsoUtc, parseDueAt, localDate, businessSeconds } from "./time.js";

const TARGET_MINUTES = { high: 60, medium: 240, low: 480 };
const DEFAULT_TARGET_MINUTES = 480; // Rule 5: Low or null priority.

// Rule 1: canceled, deleted and merged requests never count.
export function isCounted(request) {
  return request.status !== "canceled" && !request.deleted_at && !request.merged_into_id;
}

// Rule 2: drop every reverting event and every event it reverts.
export function survivingEvents(events) {
  const dropped = new Set();
  for (const e of events) {
    if (e.reverts_id != null) {
      dropped.add(e.id);
      dropped.add(e.reverts_id);
    }
  }
  return events.filter((e) => !dropped.has(e.id));
}

// Chronological order; events at the same second fall back to id.
function byTime(a, b) {
  return a.at - b.at || a.id - b.id;
}

function targetMinutes(priority) {
  return TARGET_MINUTES[String(priority ?? "").toLowerCase()] ?? DEFAULT_TARGET_MINUTES;
}

// Rule 6: last completion strictly after the latest deadline. null when either is missing.
// `events` is in time order, so walk back from the newest: the first completion
// and the first parseable due_at found are the ones that count.
function completedLate(events, timezone) {
  const completion = events.findLast((e) => e.status === "complete");
  if (!completion) return null; // never completed: no need to parse deadlines
  for (let i = events.length - 1; i >= 0; i--) {
    const deadline = parseDueAt(events[i].due_at, timezone);
    if (deadline != null) return completion.at > deadline;
  }
  return null; // no deadline
}

// Why a response counts as 0 business minutes, for the page; null otherwise.
function responseNote(createdAt, respondedAt, seconds) {
  if (seconds >= 60) return null;
  if (respondedAt < createdAt) return "before creation";
  return seconds === 0 ? "outside business hours" : "under a minute";
}

// One report row for a request. `holidays` is a Set of site-local "YYYY-MM-DD";
// `staff` maps staff id to {id, name} with current names.
export function computeRow({ request, events, site, holidays, staff }) {
  const createdAt = parseIsoUtc(request.created_at);
  const timeline = survivingEvents(events)
    .map((e) => ({ ...e, at: Number(e.at) }))
    .sort(byTime);

  // Rule 3: first processing event by a person (System events have no actor_id).
  const first = timeline.find((e) => e.status === "processing" && e.actor_id != null);

  let responder = {
    responder_id: null, responder: null, response_business_minutes: null, within_target: null,
    response_elapsed_minutes: null, response_note: null,
  };
  if (first) {
    // Rule 4: business seconds from creation to first response, floored to
    // minutes; 0 if the response came first.
    const seconds = businessSeconds(createdAt, first.at, site, holidays);
    const minutes = Math.floor(seconds / 60);
    responder = {
      responder_id: first.actor_id,
      responder: staff.get(first.actor_id)?.name ?? first.actor_name ?? null,
      response_business_minutes: minutes,
      within_target: minutes <= targetMinutes(request.priority), // Rule 5
      response_elapsed_minutes: Math.floor((first.at - createdAt) / 60),
      response_note: responseNote(createdAt, first.at, seconds),
    };
  }

  return {
    id: request.id,
    site_id: request.site_id,
    created_date: localDate(createdAt, site.timezone),
    ...responder,
    completed_late: completedLate(timeline, site.timezone),
  };
}
