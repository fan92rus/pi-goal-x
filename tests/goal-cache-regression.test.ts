import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Shared JavaScript experiment entry point.
import { summarize, compareReports } from "../experiments/context/cache-report.mjs";

const report = () => ({version: 1, rows: [{id: "fixture", ...summarize({messages: [{role: "system", content: "policy"}, {role: "user", content: "history"}], tools: [{name: "read", parameters: {type: "object"}}], prompt_cache_key: "fixed"})}]});

test("cache comparison rejects missing scenarios, early text, schemas, options, markers and duplicate blocks", () => {
 const baseline = report();
 assert.equal(compareReports(baseline, structuredClone(baseline)).scenarios, 1);
 const variants = [
  (r: any) => { r.rows = []; },
  (r: any) => { r.rows[0].blocks[0].hash = "edited"; },
  (r: any) => { r.rows[0].immutable = "reordered or changed tools"; },
  (r: any) => { r.rows[0].options = "rotating identity"; },
  (r: any) => { r.rows[0].markers = [{path: ["messages", "0"], value: {type: "ephemeral"}}]; },
  (r: any) => { r.rows[0].blocks.push(r.rows[0].blocks[1]); },
 ];
 for (const mutate of variants) {
  const candidate = structuredClone(baseline);
  mutate(candidate);
  assert.throws(() => compareReports(baseline, candidate));
 }
 assert.throws(() => summarize({messages: [{role: "user", content: [{type: "text", text: "live", cache_control: {type: "ephemeral"}}]}]}, ["live"]), /marker on a transient/);
});

test("approved display removal must be exact and confined to a goal counter block", () => {
 const baseline = {version: 1, rows: [{id: "counter", ...summarize({messages: [{role: "user", content: "Goal snapshot: 12 tokens\nContext snapshot: unavailable\nAutonomous runs: 1/3"}]})}]};
 const candidate = {version: 1, rows: [{id: "counter", ...summarize({messages: [{role: "user", content: "Goal snapshot: 12 tokens\nAutonomous runs: 1/3"}]})}]};
 assert.equal(compareReports(baseline, candidate).approvedDifferences.length, 1);
 candidate.rows[0].blocks[0].text += " extra instruction";
 assert.throws(() => compareReports(baseline, candidate), /unexpected counter edit/);
});
