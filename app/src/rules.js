// The seven report rules from docs/rules.md as pure functions: no I/O, no clock.
import { parseIsoUtc, parseDueAt, localDate, businessSeconds, businessMinutes } from "./time.js";

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
function completedLate(events, timezone) {
  let completion = null;
  let deadline = null;
  for (const e of events) {
    if (e.status === "complete") completion = e;
    const due = parseDueAt(e.due_at, timezone);
    if (due != null) deadline = due;
  }
  if (!completion || deadline == null) return null;
  return completion.at > deadline;
}

// Why a response counts as 0 business minutes, for the page; null otherwise.
function responseNote(createdAt, respondedAt, minutes, site, holidays) {
  if (minutes > 0) return null;
  if (respondedAt < createdAt) return "before creation";
  if (businessSeconds(createdAt, respondedAt, site, holidays) === 0) return "outside business hours";
  return "under a minute";
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
    // Rule 4: business time from creation to first response, 0 if the response came first.
    const minutes = businessMinutes(createdAt, first.at, site, holidays);
    responder = {
      responder_id: first.actor_id,
      responder: staff.get(first.actor_id)?.name ?? first.actor_name ?? null,
      response_business_minutes: minutes,
      within_target: minutes <= targetMinutes(request.priority), // Rule 5
      response_elapsed_minutes: Math.floor((first.at - createdAt) / 60),
      response_note: responseNote(createdAt, first.at, minutes, site, holidays),
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
