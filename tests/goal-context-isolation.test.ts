import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
// The capture driver is shared with the command-line provider checks.
// @ts-expect-error JavaScript experiment entry point.
import { captureOne } from "../experiments/context/capture-context.mjs";

test("overlapping captures keep their own tool profile and goal", async () => {
 const [disabled, active] = await Promise.all([captureOne("tasks-disabled"), captureOne("current-contracted-task")]);
 assert.ok(!disabled.tools.some((tool: any) => tool.name === "update_goal_task"));
 assert.ok(active.tools.some((tool: any) => tool.name === "update_goal_task"));
 assert.match(JSON.stringify(active.messages), /Finish the contracted migration/);
 assert.doesNotMatch(JSON.stringify(disabled.messages), /Finish the contracted migration/);
});

test("one failing capture cannot remove a sibling paused at its read barrier", async () => {
 let release!: () => void;
 const barrier = new Promise<void>(resolve => { release = resolve; });
 let arrived!: () => void;
 const ready = new Promise<void>(resolve => { arrived = resolve; });
 let siblingPath = "", failedPath = "";
 const sibling = captureOne("tasks-disabled", {inspect: async (_result: unknown, {cwd}: {cwd: string}) => {
  siblingPath = cwd;
  arrived();
  await barrier;
  assert.equal(JSON.parse(readFileSync(path.join(cwd, ".pi/pi-goal-x-settings.json"), "utf8")).disableTasks, true);
 }});
 await ready;
 try {
  await assert.rejects(captureOne("current-contracted-task", {inspect: (_result: unknown, {cwd}: {cwd: string}) => {
   failedPath = cwd;
   assert.notEqual(cwd, siblingPath);
   throw new Error("deliberate capture failure");
  }}), /deliberate capture failure/);
  assert.equal(existsSync(failedPath), false);
  assert.equal(existsSync(siblingPath), true);
 } finally { release(); }
 await sibling;
 assert.equal(existsSync(siblingPath), false);
});
