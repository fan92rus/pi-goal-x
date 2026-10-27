/**
 * Read-only decision consultant runner (TECH §5, E4.1). Covers the role
 * payloads, the read-only tool profile, the submit path (validation, retry,
 * first-wins), deadline and AbortSignal cancellation, the config and budget
 * refusals, and usage capture. Sessions are injected fakes: no network, no
 * real models.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	runConsultant,
	type ConsultantModel,
	type ConsultantSession,
	type ConsultantSessionFactory,
	type CriticPayload,
	type ResearcherPayload,
} from "../extensions/goal-decision-consultant.ts";

const CTX = { cwd: "/tmp/goal-decision-consultant" } as unknown as ExtensionContext;
const MODEL = { provider: "fixture", id: "critic-model" } as unknown as ConsultantModel;

const RESEARCH_OK: ResearcherPayload = {
	findings: [{ claim: "The cache uses the rollback journal", evidence: "src/cache.ts sets journal_mode=DELETE", source: "src/cache.ts" }],
	remainingUnknowns: [],
	verdict: "answered",
};

const CRITIC_OK: CriticPayload = {
	objections: [{ severity: "minor", evidence: "WAL needs -shm files on network drives" }],
	verdict: "sound",
};

interface FakeSubmitTool {
	name: string;
	execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
}

interface CapturedOptions {
	model?: unknown;
	tools?: string[];
	customTools?: FakeSubmitTool[];
	sessionManager?: unknown;
	settingsManager?: unknown;
}

type FakeScript = (api: {
	submit: (params: unknown) => Promise<{ content: Array<{ text: string }> }>;
	emit: (event: unknown) => void;
}) => Promise<void> | void;

interface FakeHarness {
	factory: ConsultantSessionFactory;
	created: number;
	aborts: number;
	disposes: number;
	prompt?: string;
	options?: CapturedOptions;
}

interface FakeHarnessOptions {
	/** abort() returns a promise that never settles: the child is un-cancellable. */
	abortNeverSettles?: boolean;
}

/** Fake session whose prompt runs `script`; the script submits through the captured custom tool. */
function fakeHarness(script: FakeScript, harnessOptions: FakeHarnessOptions = {}): FakeHarness {
	const harness: FakeHarness = {
		factory: undefined as never,
		created: 0,
		aborts: 0,
		disposes: 0,
	};
	const listeners = new Set<(event: unknown) => void>();
	harness.factory = async (options) => {
		harness.created += 1;
		harness.options = options as unknown as CapturedOptions;
		const submitTool = (options.customTools as unknown as FakeSubmitTool[])[0]!;
		const session: ConsultantSession = {
			prompt: async (text) => {
				harness.prompt = text;
				await script({
					submit: (params) => submitTool.execute("call-1", params),
					emit: (event) => {
						for (const listener of listeners) listener(event);
					},
				});
			},
			abort: () => {
				harness.aborts += 1;
				return harnessOptions.abortNeverSettles ? NEVER() : undefined;
			},
			dispose: () => {
				harness.disposes += 1;
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};
		return { session };
	};
	return harness;
}

const NEVER = (): Promise<void> => new Promise<void>(() => {});

describe("consultant session profile", () => {
	it("researcher: read-only tools plus its submit tool, fresh isolated session, valid payload returned", async () => {
		const harness = fakeHarness(async ({ submit }) => {
			await submit(RESEARCH_OK);
		});
		const run = await runConsultant({
			ctx: CTX,
			role: "researcher",
			prompt: "Does the cache use WAL? Compare <A> & <B>.",
			model: MODEL,
			deadlineMs: 5_000,
			createSession: harness.factory,
		});
		assert.equal(run.ok, true);
		if (run.ok) assert.deepEqual(run.payload, RESEARCH_OK);
		assert.deepEqual(harness.options?.tools, ["read", "grep", "find", "ls", "submit_researcher_findings"]);
		assert.deepEqual(harness.options?.customTools?.map((tool) => tool.name), ["submit_researcher_findings"]);
		assert.equal(harness.options?.model, MODEL);
		assert.ok(harness.options?.sessionManager, "in-memory session manager");
		assert.ok(harness.options?.settingsManager, "in-memory settings manager");
		assert.match(harness.prompt ?? "", /submit_researcher_findings/);
		assert.match(harness.prompt ?? "", /Compare &lt;A&gt; &amp; &lt;B&gt;\./, "request text is escaped inside its tag");
		assert.equal(harness.disposes, 1);
		assert.equal(harness.aborts, 0);
	});

	it("critic: uses the supplied model and returns a valid critic payload", async () => {
		const harness = fakeHarness(async ({ submit }) => {
			await submit(CRITIC_OK);
		});
		const run = await runConsultant({
			ctx: CTX,
			role: "critic",
			prompt: "Critique WAL.",
			model: MODEL,
			deadlineMs: 5_000,
			createSession: harness.factory,
		});
		assert.equal(run.ok, true);
		if (run.ok) assert.deepEqual(run.payload, CRITIC_OK);
		assert.deepEqual(harness.options?.tools, ["read", "grep", "find", "ls", "submit_critic_objections"]);
		assert.deepEqual(harness.options?.customTools?.map((tool) => tool.name), ["submit_critic_objections"]);
		assert.equal(harness.options?.model, MODEL);
	});

});

describe("consultant submit validation", () => {
	it("an invalid payload is a tool error and, with no valid retry, becomes invalid_output", async () => {
		const harness = fakeHarness(async ({ submit }) => {
			await assert.rejects(submit({ ...RESEARCH_OK, verdict: "maybe" }), /Invalid submit_researcher_findings payload/);
			await assert.rejects(submit({ ...RESEARCH_OK, findings: [{ claim: "   ", evidence: "e", source: "s" }] }), /Invalid submit_researcher_findings payload/);
		});
		const run = await runConsultant({ ctx: CTX, role: "researcher", prompt: "Q", model: MODEL, deadlineMs: 5_000, createSession: harness.factory });
		assert.equal(run.ok, false);
		if (!run.ok) assert.equal(run.errorCode, "invalid_output");
	});

	it("a rejected payload does not block a later valid submit", async () => {
		const harness = fakeHarness(async ({ submit }) => {
			await assert.rejects(submit({ objections: [{ severity: "fatal", evidence: "x" }], verdict: "sound" }));
			await submit(CRITIC_OK);
		});
		const run = await runConsultant({ ctx: CTX, role: "critic", prompt: "Q", model: MODEL, deadlineMs: 5_000, createSession: harness.factory });
		assert.equal(run.ok, true);
		if (run.ok) assert.deepEqual(run.payload, CRITIC_OK);
	});

	it("a session that never submits yields invalid_output", async () => {
		const harness = fakeHarness(() => {});
		const run = await runConsultant({ ctx: CTX, role: "critic", prompt: "Q", model: MODEL, deadlineMs: 5_000, createSession: harness.factory });
		assert.equal(run.ok, false);
		if (!run.ok) assert.equal(run.errorCode, "invalid_output");
	});

	it("a second valid submit does not replace the first (first wins)", async () => {
		let secondText = "";
		const harness = fakeHarness(async ({ submit }) => {
			await submit(RESEARCH_OK);
			const second = await submit({ ...RESEARCH_OK, verdict: "insufficient" });
			secondText = second.content[0]!.text;
		});
		const run = await runConsultant({ ctx: CTX, role: "researcher", prompt: "Q", model: MODEL, deadlineMs: 5_000, createSession: harness.factory });
		assert.equal(run.ok, true);
		if (run.ok) assert.equal(run.payload.verdict, "answered");
		assert.match(secondText, /first submission stands/);
	});
});

describe("consultant cancellation", () => {
	it("deadline expiry aborts the child and returns aborted even if the prompt never settles", async () => {
		const harness = fakeHarness(NEVER);
		const run = await runConsultant({ ctx: CTX, role: "researcher", prompt: "Q", model: MODEL, deadlineMs: 20, createSession: harness.factory });
		assert.equal(run.ok, false);
		if (!run.ok) {
			assert.equal(run.errorCode, "aborted");
			assert.match(run.message, /deadline/);
		}
		assert.equal(harness.aborts, 1);
		assert.equal(harness.disposes, 1);
	});

	it("AbortSignal aborts the child and returns aborted", async () => {
		const controller = new AbortController();
		const harness = fakeHarness(() => {
			controller.abort();
			return NEVER();
		});
		const run = await runConsultant({
			ctx: CTX,
			role: "critic",
			prompt: "Q",
			model: MODEL,
			deadlineMs: 60_000,
			signal: controller.signal,
			createSession: harness.factory,
		});
		assert.equal(run.ok, false);
		if (!run.ok) {
			assert.equal(run.errorCode, "aborted");
			assert.match(run.message, /cancelled/);
		}
		assert.equal(harness.aborts, 1);
		assert.equal(harness.disposes, 1);
	});

	it("an already-aborted signal launches nothing", async () => {
		const controller = new AbortController();
		controller.abort();
		const harness = fakeHarness(async ({ submit }) => {
			await submit(RESEARCH_OK);
		});
		const run = await runConsultant({
			ctx: CTX,
			role: "researcher",
			prompt: "Q",
			model: MODEL,
			deadlineMs: 5_000,
			signal: controller.signal,
			createSession: harness.factory,
		});
		assert.equal(run.ok, false);
		if (!run.ok) assert.equal(run.errorCode, "aborted");
		assert.equal(harness.created, 0);
	});

	it("a cancelled child that reaches idle is not orphaned and is disposed", async () => {
		const controller = new AbortController();
		const harness = fakeHarness(() => {
			controller.abort();
			return NEVER();
		});
		const run = await runConsultant({ ctx: CTX, role: "critic", prompt: "Q", model: MODEL, deadlineMs: 60_000, signal: controller.signal, createSession: harness.factory });
		assert.equal(run.ok, false);
		if (!run.ok) {
			assert.equal(run.errorCode, "aborted");
			assert.equal(run.orphaned, undefined);
		}
		assert.equal(harness.disposes, 1);
	});

	it("a child whose abort never settles is orphaned after the grace period and is not disposed", async () => {
		const controller = new AbortController();
		const harness = fakeHarness(() => {
			controller.abort();
			return NEVER();
		}, { abortNeverSettles: true });
		const started = Date.now();
		const run = await runConsultant({
			ctx: CTX,
			role: "critic",
			prompt: "Q",
			model: MODEL,
			deadlineMs: 60_000,
			cancelGraceMs: 20,
			signal: controller.signal,
			createSession: harness.factory,
		});
		const elapsed = Date.now() - started;
		assert.equal(run.ok, false);
		if (!run.ok) {
			assert.equal(run.errorCode, "aborted");
			assert.equal(run.orphaned, true);
			assert.match(run.message, /orphaned/);
		}
		assert.equal(harness.aborts, 1);
		assert.equal(harness.disposes, 0, "an orphaned session is not disposed while it may still run");
		assert.ok(elapsed < 5_000, `returned after the grace period, not after the 60 s deadline (${elapsed} ms)`);
	});

	it("a submission after cancellation is refused and never becomes the result", async () => {
		const controller = new AbortController();
		let late: { content: Array<{ text: string }> } | undefined;
		const harness = fakeHarness(async ({ submit }) => {
			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 10));
			late = await submit(RESEARCH_OK);
		});
		const run = await runConsultant({ ctx: CTX, role: "researcher", prompt: "Q", model: MODEL, deadlineMs: 60_000, signal: controller.signal, createSession: harness.factory });
		assert.equal(run.ok, false);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.match(late?.content[0]?.text ?? "", /not recorded/);
	});

	it("a deadline that fires during session creation aborts and disposes the late session", async () => {
		let resolveLate: ((value: { session: ConsultantSession }) => void) | undefined;
		let lateAborts = 0;
		let lateDisposes = 0;
		const factory: ConsultantSessionFactory = () => new Promise((resolve) => {
			resolveLate = resolve;
		});
		const run = await runConsultant({ ctx: CTX, role: "critic", prompt: "Q", model: MODEL, deadlineMs: 10, createSession: factory });
		assert.equal(run.ok, false);
		if (!run.ok) assert.equal(run.errorCode, "aborted");
		resolveLate!({
			session: {
				prompt: async () => {},
				abort: () => {
					lateAborts += 1;
				},
				dispose: () => {
					lateDisposes += 1;
				},
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(lateAborts, 1);
		assert.equal(lateDisposes, 1);
	});
});

describe("consultant refusals", () => {
	it("a missing model returns config and launches nothing", async () => {
		const harness = fakeHarness(async ({ submit }) => {
			await submit(RESEARCH_OK);
		});
		const run = await runConsultant({ ctx: CTX, role: "researcher", prompt: "Q", deadlineMs: 5_000, createSession: harness.factory });
		assert.equal(run.ok, false);
		if (!run.ok) assert.equal(run.errorCode, "config");
		assert.equal(harness.created, 0);
	});

	it("a refused beforeLaunch gate returns budget and launches nothing", async () => {
		const harness = fakeHarness(async ({ submit }) => {
			await submit(RESEARCH_OK);
		});
		const run = await runConsultant({
			ctx: CTX,
			role: "researcher",
			prompt: "Q",
			model: MODEL,
			deadlineMs: 5_000,
			beforeLaunch: () => ({ ok: false, reason: "token budget exhausted" }),
			createSession: harness.factory,
		});
		assert.deepEqual(run, { ok: false, errorCode: "budget", message: "token budget exhausted" });
		assert.equal(harness.created, 0);
	});

	it("an accepting beforeLaunch gate lets the consultation run", async () => {
		let gateCalls = 0;
		const harness = fakeHarness(async ({ submit }) => {
			await submit(RESEARCH_OK);
		});
		const run = await runConsultant({
			ctx: CTX,
			role: "researcher",
			prompt: "Q",
			model: MODEL,
			deadlineMs: 5_000,
			beforeLaunch: () => {
				gateCalls += 1;
				return { ok: true };
			},
			createSession: harness.factory,
		});
		assert.equal(run.ok, true);
		assert.equal(gateCalls, 1);
	});

	it("a throwing session factory returns provider with its message", async () => {
		const run = await runConsultant({
			ctx: CTX,
			role: "critic",
			prompt: "Q",
			model: MODEL,
			deadlineMs: 5_000,
			createSession: async () => {
				throw new Error("provider unavailable");
			},
		});
		assert.deepEqual(run, { ok: false, errorCode: "provider", message: "provider unavailable" });
	});
});

describe("consultant usage", () => {
	it("usage stays undefined when no session events arrive", async () => {
		const harness = fakeHarness(async ({ submit }) => {
			await submit(CRITIC_OK);
		});
		const run = await runConsultant({ ctx: CTX, role: "critic", prompt: "Q", model: MODEL, deadlineMs: 5_000, createSession: harness.factory });
		assert.equal(run.ok, true);
		if (run.ok) assert.equal(run.usage, undefined);
	});

	it("sums assistant totalTokens from message_end events and ignores other roles", async () => {
		const harness = fakeHarness(async ({ submit, emit }) => {
			emit({ type: "message_end", message: { role: "user", usage: { totalTokens: 999 } } });
			emit({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 42 } } });
			emit({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 8 } } });
			await submit(CRITIC_OK);
		});
		const run = await runConsultant({ ctx: CTX, role: "critic", prompt: "Q", model: MODEL, deadlineMs: 5_000, createSession: harness.factory });
		assert.equal(run.ok, true);
		if (run.ok) assert.deepEqual(run.usage, { tokens: 50 });
	});
});
