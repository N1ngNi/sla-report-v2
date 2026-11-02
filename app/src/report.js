// Turns computed rows into the /api/sla-report response (docs/contract.md).
import { DateTime } from "luxon";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  return typeof value === "string" && ISO_DATE.test(value) && DateTime.fromISO(value).isValid;
}

// {from, to} when both are real YYYY-MM-DD dates and from <= to, otherwise null (-> 400).
export function parseDateRange(query) {
  const { from, to } = query;
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return null;
  return { from, to };
}

// The public shape of a row: everything except our internal created_date.
export function publicRow({ created_date, ...row }) {
  return row;
}

// Rows whose site-local created date is within [from, to], plus a summary per responder.
export function buildReport(rows, from, to) {
  const requests = [];
  const responders = new Map();
  for (const row of rows) {
    if (row.created_date < from || row.created_date > to) continue;
    requests.push(publicRow(row));
    if (row.responder_id == null) continue;
    let summary = responders.get(row.responder_id);
    if (!summary) {
      summary = { id: row.responder_id, name: row.responder, requests: 0, within_target: 0, completed_late: 0 };
      responders.set(row.responder_id, summary);
    }
    summary.requests += 1;
    if (row.within_target === true) summary.within_target += 1;
    if (row.completed_late === true) summary.completed_late += 1;
  }
  return { from, to, requests, responders: [...responders.values()] };
}
