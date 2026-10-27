import test from "node:test";
import assert from "node:assert/strict";
import {stabilizationHarness, deferred} from "./stabilization-utils.ts";
import {latestAuditorResultForGoal} from "../extensions/goal-ledger.ts";
import {buildGoalHistoryBlock} from "../extensions/goal-format.ts";
import {readGoalLedger} from "../extensions/goal-ledger.ts";
import {writeActiveGoalFile} from "../extensions/storage/goal-files.ts";
import {mkdirSync, rmSync} from "node:fs";
import path from "node:path";

const approved = {approved: true, output: "Evidence checked. <approved/>", model: "fixture"};
const stale = () => {throw new Error("This extension ctx is stale after session replacement or reload.");};

for (const event of ["session_start", "session_tree", "session_shutdown"]) test(`${event}: stale getters cannot skip cleanup`, async () => {
 const h = stabilizationHarness();
 try {
  await h.start();
  let unsubscribed = 0;
  h.core.terminalInputUnsubscribe = () => {unsubscribed++;};
  const ctx = new Proxy(h.ctx, {get(target, key) {if (key === "hasUI" || key === "cwd" || key === "sessionManager") return stale(); return Reflect.get(target, key);}});
  await h.event(event, {reason: "start"}, ctx);
  assert.equal(unsubscribed, 1);
  assert.equal(h.core.terminalInputUnsubscribe, null);
  assert.equal(h.core.auditAnimationTimer, null);
  assert.equal(h.core.goalWidgetComponentRef.current, null);
 } finally {await h.cleanup();}
});

test("unexpected teardown errors stay observable after every local cleanup step", async () => {
 const h = stabilizationHarness();
 try {
  await h.start();
  h.core.terminalInputUnsubscribe = () => {throw new Error("unsubscribe failed");};
  h.core.auditAnimationTimer = setInterval(() => {}, 1000);
  await assert.rejects(h.event("session_shutdown"), /unsubscribe failed/);
  assert.equal(h.core.terminalInputUnsubscribe, null);
  assert.equal(h.core.auditAnimationTimer, null);
  assert.equal(h.core.goalWidgetComponentRef.current, null);
 } finally {await h.cleanup();}
});

test("shutdown aborts a real pending audit, records one outcome and ignores late callbacks", async () => {
 const pending = deferred<any>(), started = deferred<any>();
 let args: any;
 const h = stabilizationHarness(async options => {args = options; started.resolve(null); return pending.promise;});
 try {
  await h.start();
  const result = h.call("update_goal", {status: "complete"});
  await started.promise;
  await h.event("session_shutdown");
  assert.equal(args.signal.aborted, true);
  assert.equal(h.ledger().filter(e => e.type === "audit_result" || e.type === "audit_skipped").length, 1);
  args.onProgress({phase: "running", recentOutput: ["late"]});
  pending.resolve(approved);
  await result;
  assert.equal(h.ledger().filter(e => e.type === "audit_result" || e.type === "audit_skipped").length, 1);
  assert.equal(h.core.auditProgress, null);
  assert.equal(h.core.auditAnimationTimer, null);
  assert.equal(h.core.state.goal?.status, "active");
 } finally {pending.resolve(approved); await h.cleanup();}
});

test("a throwing auditor is settled and releases all audit resources", async () => {
 const h = stabilizationHarness(async () => {throw new Error("auditor crashed");});
 try {
  await h.start();
  const result = await h.call("update_goal", {status: "complete"});
  assert.match(result.content[0].text, /auditor crashed/);
  assert.equal(h.core.auditAnimationTimer, null);
  assert.equal(h.core.auditProgress, null);
  assert.equal(h.ledger().filter(e => e.type === "audit_result").length, 1);
 } finally {await h.cleanup();}
});

test("a newer audit start supersedes an older verdict in every history reader", async () => {
 const h = stabilizationHarness();
 try {
 const events: any = [{type: "audit_result", goalId: h.goal.id, verdict: "approved", report: "old success", at: "2026-10-26T00:00:00Z"}, {type: "audit_started", goalId: h.goal.id, at: "2026-10-27T00:00:00Z"}];
 assert.equal(latestAuditorResultForGoal(events, h.goal.id), undefined);
 const text = buildGoalHistoryBlock(h.goal, events);
 assert.match(text, /no recorded result/i);
 assert.doesNotMatch(text, /Last audit: approved/);
 } finally {await h.cleanup();}
});

test("overlapping sessions cannot attribute an older result to the newest audit", async () => {
 const a = deferred<any>(), b = deferred<any>(), aStarted = deferred<any>(), bStarted = deferred<any>();
 const first = stabilizationHarness(async () => {aStarted.resolve(null); return a.promise;});
 const second = stabilizationHarness(async () => {bStarted.resolve(null); return b.promise;});
 let firstResult: Promise<any> | undefined, secondResult: Promise<any> | undefined;
 try {
  await first.start();
  firstResult = first.call("update_goal", {status: "complete"});
  await aStarted.promise;
  const shared = {...second.ctx, cwd: first.cwd};
  await second.event("session_start", {reason: "start"}, shared);
  secondResult = second.call("update_goal", {status: "complete"}, shared);
  await bStarted.promise;
  a.resolve({...approved, approved: false, output: "older rejection"});
  await firstResult;
  assert.equal(latestAuditorResultForGoal(readGoalLedger({cwd: first.cwd}).events, first.goal.id), undefined, "newest audit still has no outcome");
 } finally {
  a.resolve(approved); b.resolve(approved);
  await Promise.allSettled([firstResult, secondResult]);
  await second.cleanup(); await first.cleanup();
 }
});

for (const external of [false, true]) test(`project replacement flushes the original ${external ? "external" : "default"} storage owner`, async () => {
 const h = stabilizationHarness(), incoming = stabilizationHarness();
 try {
  if (external) {
   h.ctx.goalStorageRoot = path.join(h.cwd, "custom-pool");
   mkdirSync(h.ctx.goalStorageRoot, {recursive: true});
   writeActiveGoalFile(h.ctx, h.goal);
   const entries = h.ctx.sessionManager.getBranch();
   h.ctx.sessionManager.getBranch = () => entries.map((entry: any) => ({...entry, data: {...entry.data, storageRoot: h.ctx.goalStorageRoot}}));
  }
  writeActiveGoalFile(incoming.ctx, {...incoming.goal, objective: "Replacement project's independent work"});
  const beforeIncoming = incoming.disk();
  await h.start();
  await h.call("set_goal_tasks", {tasks: [{id: "task", title: "Finish"}], block_completion: true});
  await h.event("turn_end", {message: {role: "assistant", stopReason: "stop"}});
  await h.event("turn_start");
  await h.call("update_goal_task", {task_id: "task", status: "complete", evidence: "verified"});
  await h.event("session_start", {reason: "start"}, incoming.ctx);
  const outgoing = readGoalLedger(external ? {cwd: h.cwd, goalStorageRoot: h.ctx.goalStorageRoot} : {cwd: h.cwd});
  assert.ok(outgoing.events.some(e => e.type === "task_complete"));
  assert.equal(incoming.disk(), beforeIncoming, "incoming file is never the outgoing transaction's destination");
  assert.equal(h.core.state.goal?.objective, "Replacement project's independent work");
  await h.event("session_shutdown", {}, h.ctx);
  assert.equal(h.core.state.goal?.objective, "Replacement project's independent work", "late shutdown cannot retire the replacement");
 } finally {await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();}
});

test("late audit progress and finally cannot touch the replacement audit with equal external IDs", async () => {
 const old = deferred<any>(), next = deferred<any>(), firstStarted = deferred<any>(), nextStarted = deferred<any>();
 const callbacks: any[] = [];
 const h = stabilizationHarness(async args => {
  callbacks.push(args);
  if (callbacks.length === 1) {firstStarted.resolve(null); return old.promise;}
  nextStarted.resolve(null); return next.promise;
 });
 const incoming = stabilizationHarness();
 let first: Promise<any> | undefined, second: Promise<any> | undefined;
 try {
  await h.start(); first = h.call("update_goal", {status: "complete"}); await firstStarted.promise;
  await h.event("session_start", {reason: "start"}, incoming.ctx);
  second = h.call("update_goal", {status: "complete"}, incoming.ctx); await nextStarted.promise;
  const progress = h.core.auditProgress, timer = h.core.auditAnimationTimer;
  callbacks[0].onProgress({phase: "running", recentOutput: ["obsolete"]});
  old.resolve(approved); await first;
  assert.equal(h.core.auditProgress, progress);
  assert.equal(h.core.auditAnimationTimer, timer);
  assert.equal(callbacks[0].signal.aborted, true);
  assert.equal(h.core.state.goal?.status, "active");
  assert.equal(h.ledger().filter(e => e.type === "audit_result").length, 1);
  assert.equal(incoming.ledger().filter(e => e.type === "audit_result").length, 0);
 } finally {
  old.resolve(approved); next.resolve({...approved, approved: false});
  await Promise.allSettled([first, second]);
  await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();
 }
});

test("session replacement while the Escape choice is pending retires exactly one attempt", async () => {
 const pending = deferred<any>(), started = deferred<any>(), choice = deferred<string>(), shown = deferred<any>();
 const h = stabilizationHarness(async () => {started.resolve(null); return pending.promise;}), incoming = stabilizationHarness();
 let result: Promise<any> | undefined;
 try {
  h.ctx.hasUI = true;
  h.ctx.ui.custom = async () => {shown.resolve(null); return choice.promise;};
  await h.start(); result = h.call("update_goal", {status: "complete"}); await started.promise;
  h.core.abortAudit(h.ctx); pending.resolve({...approved, approved: false, error: "Auditor aborted."}); await shown.promise;
  await h.event("session_start", {reason: "start"}, incoming.ctx);
  h.core.goalModalDepth = 1;
  choice.resolve("complete_without_audit"); await result;
  assert.equal(h.core.goalModalDepth, 1, "old dialog cannot consume the new modal lease");
  assert.equal(h.core.state.goal?.status, "active");
  assert.equal(h.ledger().filter(e => e.type === "audit_result" || e.type === "audit_skipped").length, 1);
 } finally {choice.resolve("continue_working"); pending.resolve(approved); await result; await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();}
});

test("audit approval cannot overwrite tasks changed by another writer", async () => {
 const pending = deferred<any>(), started = deferred<any>();
 const h = stabilizationHarness(async () => {started.resolve(null); return pending.promise;});
 try {
  await h.start(); const result = h.call("update_goal", {status: "complete"}); await started.promise;
  writeActiveGoalFile(h.ctx, {...h.core.state.goal!, revision: (h.core.state.goal?.revision ?? 0) + 1, taskList: {tasks: [{id: "new", title: "Unreviewed requirement", status: "pending"}], blockCompletion: true, proposedAt: new Date().toISOString()}});
  pending.resolve(approved);
  assert.match((await result).content[0].text, /changed during the audit/);
  assert.equal(h.core.state.goal?.status, "active");
  assert.match(h.disk(), /Unreviewed requirement/);
 } finally {pending.resolve(approved); await h.cleanup();}
});

test("failed audit ledger persistence is visible and cannot complete the goal", async () => {
 const pending = deferred<any>(), started = deferred<any>();
 const h = stabilizationHarness(async () => {started.resolve(null); return pending.promise;});
 try {
  await h.start(); const result = h.call("update_goal", {status: "complete"}); await started.promise;
  const ledger = path.join(h.cwd, ".pi/goals/goal_events.jsonl");
  rmSync(ledger); mkdirSync(ledger);
  pending.resolve(approved);
  const response = await result;
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /could not be persisted/);
  assert.equal(h.core.state.goal?.status, "active");
  assert.equal(h.core.activeAudit, null);
 } finally {pending.resolve(approved); await h.cleanup();}
});

test("late shutdown cannot evict a replacement prefix with the same cache identity", async () => {
 const h = stabilizationHarness(), incoming = stabilizationHarness();
 const base: any[] = [{role: "user", content: "stable history", timestamp: 1}];
 try {
  await h.start();
  await h.event("context_with_system", {messages: base});
  await h.event("session_start", {reason: "start"}, incoming.ctx);
  const first = (await h.event("context_with_system", {messages: base}, incoming.ctx)).messages;
  base.push({role: "assistant", content: [{type: "text", text: "progress"}], timestamp: 2});
  const advanced = (await h.event("context_with_system", {messages: base}, incoming.ctx)).messages;
  assert.deepEqual(advanced.slice(0, first.length), first);
  await h.event("session_shutdown", {}, h.ctx);
  assert.deepEqual((await h.event("context_with_system", {messages: base}, incoming.ctx)).messages, advanced);
 } finally {await h.event("session_shutdown", {}, incoming.ctx); await h.cleanup(); await incoming.cleanup();}
});
