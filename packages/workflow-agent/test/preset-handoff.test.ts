import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	HandoffInbox,
	handoffMessage,
	type HandoffMessage,
	type HandoffSession,
	type PresetTarget,
} from "../src/presets/handoff-protocol";
import { superviseHandoffs, type HandoffPeer } from "../src/presets/handoff-supervisor";
import { readSessionSnapshot } from "../src/runtime/session-snapshot";
import { requestPresetTransition } from "../src/tui/preset-transition";
import type { RunState } from "../src/runtime/state";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ProductSessions } from "../src/runtime/sessions";
import { PreparedTranscript } from "../src/presets/prepared-transcript";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

for (const changed of [false, true])
	test(`prepared transcript buffers startup entries, preserves ownership and ${changed ? "rejects outside changes" : "publishes before later appends"}`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-transcript-"));
		let staged: SessionManager | undefined;
		try {
			const original = SessionManager.create(dir, dir);
			await original.ensureOnDisk();
			const file = original.getSessionFile()!;
			await original.close();
			const before = await Bun.file(file).text();
			const preparation = new PreparedTranscript(file, await Bun.file(file).bytes());
			staged = await SessionManager.open(file, dir, preparation.storage);
			staged.requireExclusiveWriter();
			staged.appendCustomEntry("prepared", { stage: true });
			await staged.flush();
			expect(await Bun.file(file).text()).toBe(before);
			if (changed) {
				await Bun.write(file, `${before}{"type":"custom","customType":"external"}\n`);
				await expect(preparation.activate(staged)).rejects.toThrow("changed");
				expect(await Bun.file(file).text()).not.toContain('"customType":"prepared"');
			} else {
				await preparation.activate(staged);
				expect(await Bun.file(file).text()).toContain('"customType":"prepared"');
				staged.appendCustomEntry("activated", { stage: false });
				await staged.flush();
				expect(await Bun.file(file).text()).toContain('"customType":"activated"');
			}
		} finally {
			await staged?.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

test("handoff idle gate refuses every owned activity without stopping it and freezes later submissions", () => {
	const activity: Record<string, boolean | number> = {};
	let pending = false;
	let goal: { enabled: boolean; mode: string } | undefined;
	let jobs = false;
	const state = {
		jobs: {
			get hasActiveJobs() {
				return jobs;
			},
		},
		handoff: { busy: false },
	} as unknown as RunState;
	const session = new Proxy(
		{ hasPendingAsyncWork: () => pending, getGoalModeState: () => goal },
		{
			get(target, key) {
				return typeof key === "string" && key in activity ? activity[key] : Reflect.get(target, key);
			},
		},
	) as unknown as AgentSession;
	const controller = new ProductSessions(state, session, async () => {});
	expect(() => controller.assertIdle()).not.toThrow();
	for (const key of [
		"hasAdmittedSubmission",
		"isStreaming",
		"isCompacting",
		"isRetrying",
		"hasPostPromptWork",
		"queuedMessageCount",
		"isSessionTransitioning",
		"hasActiveEphemeralTurns",
	]) {
		activity[key] = key === "queuedMessageCount" ? 1 : true;
		expect(() => controller.assertIdle()).toThrow("会话仍在运行");
		delete activity[key];
	}
	pending = true;
	expect(() => controller.assertIdle()).toThrow();
	pending = false;
	jobs = true;
	expect(() => controller.assertIdle()).toThrow("后台任务");
	jobs = false;
	goal = { enabled: true, mode: "active" };
	expect(() => controller.assertIdle()).toThrow("目标");
	goal = { enabled: false, mode: "exiting" };
	expect(() => controller.assertIdle()).toThrow("目标");
	goal = undefined;
	controller.busy = true;
	expect(() => controller.assertIdle()).toThrow();
	controller.busy = false;
	state.handoff!.busy = true;
	expect(() => controller.assertSubmissionAllowed()).toThrow("正在交接");
});

test("long preparation outlives the input hook and reports its later failure without an unhandled rejection", async () => {
	const pending = Promise.withResolvers<void>();
	const notifications: string[] = [];
	const state = { handoff: { busy: false, switch: () => pending.promise } } as unknown as RunState;
	const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext;
	expect(requestPresetTransition(state, ctx, { preset: "chat" })).toBeUndefined();
	expect(notifications).toHaveLength(0);
	pending.reject(new Error("late preparation failure"));
	await Promise.resolve();
	expect(notifications).toEqual(["late preparation failure"]);
});

test("IPC rejects foreign identities, malformed requests, traversal, full grants and non-boolean plan state", () => {
	const token = Bun.randomUUIDv7();
	const input = {
		version: 1,
		token,
		type: "request",
		requestId: Bun.randomUUIDv7(),
		target: { preset: "chat", plan: true },
	};
	expect(handoffMessage(input, token)?.target?.preset).toBe("chat");
	for (const value of [
		{ ...input, token: "foreign" },
		{ ...input, requestId: "not-a-request" },
		{ ...input, target: { preset: "../chat" } },
		{ ...input, target: { preset: "chat", permissions: "full" } },
		{ ...input, target: { preset: "chat", plan: "true" } },
		{ ...input, target: { preset: "chat", light: true } },
	])
		expect(handoffMessage(value, token)).toBeUndefined();
});

test("aborted IPC waiter cannot consume the next owned message", async () => {
	const inbox = new HandoffInbox();
	const controller = new AbortController();
	const pending = inbox.next(controller.signal);
	controller.abort(new Error("cancel"));
	await expect(pending).rejects.toThrow("cancel");
	inbox.put({ version: 1, token: "t", type: "online" });
	expect((await inbox.next(new AbortController().signal)).type).toBe("online");
});

test("versioned runtime choices accept only a connection key, supported effort and boolean plan", () => {
	expect(readSessionSnapshot({})).toBeUndefined();
	expect(
		readSessionSnapshot({ runtime: { version: 1, model: { model: "secondary", effort: "max" }, plan: true } })?.model
			.model,
	).toBe("secondary");
	expect(() =>
		readSessionSnapshot({ runtime: { version: 1, model: { model: "secondary", effort: "bad" }, plan: true } }),
	).toThrow();
});

for (const failure of [
	"none",
	"prepare",
	"activate",
	"cleanup",
	"cancel",
	"timeout",
	"rollback",
	"foreign",
	"duplicate",
	"occupied",
	"ack-lost",
	"cancel-linked",
] as const)
	test(`supervisor owns terminal and preserves source/target during ${failure}`, async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-"));
		const cwd = await fs.realpath(home);
		const launchHome = failure === "cancel-linked" ? path.join(home, "home-alias") : home;
		if (launchHome !== home) await fs.symlink(home, launchHome, process.platform === "win32" ? "junction" : "dir");
		const requestId = Bun.randomUUIDv7();
		const source: HandoffSession = { id: Bun.randomUUIDv7(), preset: "a", resume: "", plan: true };
		source.resume = path.join(home, "presets/a/sessions", `source_${source.id}.jsonl`);
		const target: PresetTarget = { preset: "b" };
		const events: string[] = [];
		const peers: HandoffPeer[] = [];
		let sourceReceive: (message: HandoffMessage) => void;
		const notices: string[] = [];
		const writeSession = async (session: HandoffSession) => {
			await Bun.write(session.resume, "owned-session");
			await Bun.write(
				path.join(home, "state", session.id, "manifest.json"),
				JSON.stringify({ sessionId: session.id, cwd, preset: { id: session.preset } }),
			);
		};
		await writeSession(source);
		const existing: HandoffSession = { id: Bun.randomUUIDv7(), preset: "b", resume: "" };
		if (failure === "occupied") {
			existing.resume = path.join(home, "presets/b/sessions", `existing_${existing.id}.jsonl`);
			await writeSession(existing);
			target.resume = existing.resume;
		}
		try {
			const code = await superviseHandoffs(
				{
					home: launchHome,
					cwd,
					timeoutMs: 300,
					notify: message => notices.push(message),
					recoverCommand: () => "RECOVER_ORIGINAL_A",
					spawn(destination, prepared, receive) {
						const done = Promise.withResolvers<number>();
						const inbox = new HandoffInbox();
						const index = peers.length;
						const publish = (type: HandoffMessage["type"], fields: Partial<HandoffMessage> = {}) => {
							const message: HandoffMessage = { version: 1, token: "t", type, ...fields };
							receive(message);
							inbox.put(message);
						};
						const finish = (exit = 0) => {
							done.resolve(exit);
							inbox.close(new Error("exited"));
						};
						const peer: HandoffPeer = {
							done: done.promise,
							inbox,
							async stop() {
								events.push(`stop:${index}`);
								finish();
							},
							send(message) {
								events.push(`${message.type}:${index}`);
								if (message.type === "close") {
									if (failure === "cleanup") {
										publish("failed", { error: "source close failed" });
										return;
									}
									if (failure !== "ack-lost") publish("closed", { requestId });
									finish();
									events.push("source-exited");
								}
								if (message.type === "failed") {
									if (failure === "duplicate") publish("request", { requestId, target, session: source });
									finish();
								}
								if (message.type === "activate") {
									expect(events).toContain("source-exited");
									if (failure === "activate" || failure === "rollback") {
										publish("failed", { error: "activate failed" });
										finish(1);
									} else {
										publish("online", { session: peer.allocated });
										queueMicrotask(() => finish());
									}
								}
							},
						};
						peers.push(peer);
						if (index === 0) sourceReceive = receive;
						queueMicrotask(() => {
							void (async () => {
								if (!prepared) {
									if (index > 0 && failure === "rollback") {
										publish("failed", { error: "rollback failed" });
										finish(1);
										return;
									}
									publish("online", { session: source });
									if (index === 0)
										publish("request", {
											requestId,
											target,
											session: failure === "foreign" ? { ...source, preset: "b" } : source,
										});
									else queueMicrotask(() => finish());
									return;
								}
								expect(destination.plan).toBe(true);
								if (failure === "occupied") {
									publish("failed", { error: "target lease held" });
									return;
								}
								const allocated: HandoffSession = { id: Bun.randomUUIDv7(), preset: "b", resume: "" };
								allocated.resume = path.join(home, "presets/b/sessions", `target_${allocated.id}.jsonl`);
								peer.allocated = allocated;
								await writeSession(allocated);
								if (failure === "cancel" || failure === "cancel-linked") {
									sourceReceive({ version: 1, token: "t", type: "cancel", requestId });
									return;
								}
								if (failure === "timeout") return;
								if (failure === "prepare" || failure === "duplicate") {
									publish("failed", { error: "prepare failed" });
									return;
								}
								publish("prepared", { session: allocated });
							})().catch(error => {
								publish("failed", { error: String(error) });
								finish(1);
							});
						});
						return peer;
					},
				},
				source,
			);
			expect(code).toBe(failure === "rollback" ? 1 : 0);
			expect(await Bun.file(source.resume).exists()).toBe(true);
			if (["prepare", "cancel", "cancel-linked", "timeout", "duplicate"].includes(failure)) {
				expect(events).not.toContain("close:0");
				expect(await Bun.file(peers[1].allocated!.resume).exists()).toBe(false);
			}
			if (failure === "cleanup") expect(events).not.toContain("activate:1");
			if (["activate", "cleanup", "rollback"].includes(failure)) expect(peers).toHaveLength(3);
			if (failure === "foreign") expect(peers).toHaveLength(1);
			if (failure === "occupied") {
				expect(await Bun.file(existing.resume).exists()).toBe(true);
				expect(events).not.toContain("close:0");
			}
			if (failure === "duplicate") expect(peers).toHaveLength(2);
			if (failure === "rollback") expect(notices.join("\n")).toContain("RECOVER_ORIGINAL_A");
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	});
