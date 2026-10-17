import { expect, test } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import { fixture } from "./helpers";

interface TranscriptMessage {
	role: string;
	content: unknown;
	stopReason?: string;
}

interface BtwResult {
	before: TranscriptMessage[];
	after: TranscriptMessage[];
	messages: TranscriptMessage[];
	records: { question: string; answer: string; status: string }[];
	mainStreaming: boolean;
	userTask: string;
	goal: string;
	overlay: boolean;
	sessionFile: string;
	branch?: { ready: boolean; sessionUnchanged: boolean };
}

async function runBtw(
	home: string,
	cwd: string,
	action: "ask" | "cancel" | "history" | "tool-call" | "branch",
	resume?: string,
) {
	const resultFile = path.join(home, `btw-${action}-result.json`);
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "btw-worker.ts"),
			JSON.stringify({ home, cwd, resultFile, action, resume }),
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: os.homedir(),
				TERM: "dumb",
				PRODUCT_TEST_KEY: "fake-local-key",
				PI_CONFIG_DIR: path.relative(os.homedir(), path.join(home, "omp")),
				PI_CODING_AGENT_DIR: path.join(home, "omp/agent"),
				PI_NATIVES_DIR: path.join(home, "natives"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_APP_NAME: "my-agent",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, `${stderr}\n${stdout}`).toBe(0);
	return (await Bun.file(resultFile).json()) as BtwResult;
}

// Removing the product pass-through must stop these questions before a model
// request; accidentally treating them as prompts must alter the main transcript.
test("product /btw answers with main context, saves side history, and reopens it after resume", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		f.respond(request => ({
			text: JSON.stringify(request.messages.at(-1)?.content).includes("SIDE_QUESTION")
				? "SIDE_ANSWER"
				: "MAIN_ANSWER",
		}));
		const run = await runBtw(f.home, f.cwd, "ask");
		expect(run.after).toEqual(run.before);
		expect(run.records).toMatchObject([
			{ question: "Explain SIDE_QUESTION", answer: "SIDE_ANSWER", status: "complete" },
		]);
		expect(run.userTask).toBe("MAIN_OBJECTIVE main transcript context");
		expect(run.goal).toBe("MAIN_GOAL_OBJECTIVE");
		expect(run.overlay).toBe(true);
		expect(f.requests).toHaveLength(2);
		const side = f.requests[1];
		expect(JSON.stringify(side.messages)).toContain("MAIN_OBJECTIVE main transcript context");
		expect(JSON.stringify(side.messages)).toContain("MAIN_ANSWER");
		const resumed = await runBtw(f.home, f.cwd, "history", run.sessionFile);
		expect(resumed.records).toEqual(run.records);
		expect(resumed.messages.map(({ role, content }) => ({ role, content }))).toEqual(
			run.messages.map(({ role, content }) => ({ role, content })),
		);
		expect(resumed.overlay).toBe(true);
		expect(f.requests).toHaveLength(2);
	} finally {
		await f.close();
	}
}, 30_000);

test("cancelling product /btw leaves a running main turn able to finish its file change", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		f.callTool("write", { path: "main.txt", content: "MAIN_FINISHED" });
		f.stallChild();
		const run = await runBtw(f.home, f.cwd, "cancel");
		expect(run.mainStreaming).toBe(true);
		expect(run.after).toEqual(run.before);
		expect(run.records).toMatchObject([{ question: "STALL_CHILD side question", status: "cancelled" }]);
		expect(run.userTask).toBe("MAIN_OBJECTIVE write the requested main file");
		expect(run.goal).toBe("MAIN_GOAL_OBJECTIVE");
		expect(await Bun.file(path.join(f.cwd, "main.txt")).text()).toBe("MAIN_FINISHED");
		expect(run.messages.at(-1)?.stopReason).toBe("stop");
		const side = f.requests.find(request => JSON.stringify(request.messages.at(-1)?.content).includes("STALL_CHILD"));
		expect(side).toBeDefined();
		expect(JSON.stringify(side!.messages)).toContain("MAIN_OBJECTIVE write the requested main file");
	} finally {
		await f.close();
	}
}, 30_000);

test("product /btw discards a provider tool call instead of changing files or main history", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		f.respond(request =>
			JSON.stringify(request.messages.at(-1)?.content).includes("SIDE_TOOL_ATTEMPT")
				? { call: { name: "write", arguments: { path: "side.txt", content: "SIDE_MUST_NOT_WRITE" } } }
				: { text: "MAIN_ANSWER" },
		);
		const run = await runBtw(f.home, f.cwd, "tool-call");
		expect(run.after).toEqual(run.before);
		expect(run.records).toMatchObject([{ question: "SIDE_TOOL_ATTEMPT", status: "complete" }]);
		expect(await Bun.file(path.join(f.cwd, "side.txt")).exists()).toBe(false);
		expect(f.requests).toHaveLength(2);
	} finally {
		await f.close();
	}
}, 30_000);

test("print CLI refuses /btw instead of sending its literal text as a main prompt", async () => {
	const f = await fixture();
	try {
		const run = await f.cli([], "/btw CLI_SIDE_QUESTION");
		expect(`${run.stdout}\n${run.stderr}`).toContain("交互终端");
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30_000);

test("opening product /btw keeps native branch promotion blocked", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.home, "config.json"), JSON.stringify(f.config));
		const run = await runBtw(f.home, f.cwd, "branch");
		expect(run.branch).toEqual({ ready: true, sessionUnchanged: true });
		expect(run.messages).toEqual(run.before);
		expect(run.records).toMatchObject([{ question: "Explain SIDE_QUESTION", status: "complete" }]);
		expect(f.requests).toHaveLength(2);
	} finally {
		await f.close();
	}
}, 30_000);

test("headless /btw explains that a terminal is required without sending the slash command to the model", async () => {
	const f = await fixture();
	try {
		const run = await f.run({ action: "submit", commands: ["/help"], command: "/btw SIDE_QUESTION" });
		expect(run.code, run.stderr).toBe(0);
		expect(run.result.actionResult).toEqual({ handled: true });
		expect(run.result.notifications.some((text: string) => text.includes("交互终端"))).toBe(true);
		expect(run.result.displays.find((display: { title: string }) => display.title === "命令帮助").text).toContain(
			"/btw",
		);
		expect(f.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30_000);
