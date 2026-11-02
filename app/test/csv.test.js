import { test } from "node:test";
import assert from "node:assert/strict";
import { csvField, toCsv } from "../src/csv.js";

test("fields: null is empty, booleans and numbers are plain", () => {
  assert.equal(csvField(null), "");
  assert.equal(csvField(undefined), "");
  assert.equal(csvField(true), "true");
  assert.equal(csvField(false), "false");
  assert.equal(csvField(0), "0");
  assert.equal(csvField("Benjamin Tan"), "Benjamin Tan");
});

test("fields with a comma, quote or line break are quoted, quotes doubled", () => {
  assert.equal(csvField("Tan, Benjamin"), '"Tan, Benjamin"');
  assert.equal(csvField('Ben "BT" Tan'), '"Ben ""BT"" Tan"');
  assert.equal(csvField("line\nbreak"), '"line\nbreak"');
});

test("toCsv writes the header, then one line per row in the given order", () => {
  const rows = [
    { id: 2, site_id: 12, responder_id: 304, responder: "Tan, Benjamin", response_business_minutes: 0, within_target: true, completed_late: false },
    { id: 1, site_id: 11, responder_id: null, responder: null, response_business_minutes: null, within_target: null, completed_late: null },
  ];
  assert.equal(
    toCsv(rows),
    "id,site_id,responder_id,responder,response_business_minutes,within_target,completed_late\n" +
      '2,12,304,"Tan, Benjamin",0,true,false\n' +
      "1,11,,,,,\n",
  );
});

test("toCsv with no rows is just the header", () => {
  assert.equal(toCsv([]), "id,site_id,responder_id,responder,response_business_minutes,within_target,completed_late\n");
});
