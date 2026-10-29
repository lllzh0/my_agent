import { expect, spyOn, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { TemporaryTools } from "../src/runtime/temporary-tools";
import { chooseToolAccess, toolsFromCommand } from "../src/tui/tool-access";
import { toolFixture } from "./tool-fixture";

type Selection = string | undefined | ((choices: string[]) => string | undefined);

function menuContext(
	options: {
		hasUI?: boolean;
		answers?: Selection[];
		signal?: AbortSignal;
		onSelect?: () => void;
	} = {},
) {
	const selections: { title: string; choices: string[] }[] = [];
	const documents: string[] = [];
	const notifications: string[] = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		signal: options.signal,
		ui: {
			select: async (title: string, choices: string[]) => {
				selections.push({ title, choices });
				options.onSelect?.();
				const answer = options.answers?.shift();
				return typeof answer === "function" ? answer(choices) : answer;
			},
			editor: async (_title: string, body: string) => {
				documents.push(body);
			},
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;
	return { ctx, selections, documents, notifications };
}

async function accessFixture() {
	const fixture = await toolFixture();
	fixture.state.config.resources.disabled = ["tool:write", "tool:edit"];
	const access = new TemporaryTools(fixture.state, fixture.tools);
	fixture.state.toolAccess = access;
	return { ...fixture, access };
}

test("viewing tool request details then closing the choice denies without changing the request", async () => {
	const request = { tool: "write", reason: "保存审查结果", arguments: { path: "report.txt", content: "approved" } };
	const original = structuredClone(request);
	const answers = ["查看申请详情（只读）", undefined];
	const prompts: string[] = [];
	const details: string[] = [];
	const decision = await chooseToolAccess(
		request,
		async title => {
			prompts.push(title);
			return answers.shift();
		},
		async body => {
			details.push(body);
		},
	);
	expect(decision).toBe("deny");
	expect(prompts).toHaveLength(2);
	expect(details).toHaveLength(1);
	expect(details[0]).toContain("report.txt");
	expect(details[0]).toContain("approved");
	expect(request).toEqual(original);
});

test("tool access grants require their dedicated scope choice", async () => {
	const request = { tool: "write", reason: "保存结果", arguments: { path: "report.txt", content: "ok" } };
	for (const [answer, expected] of [
		["本次Agent运行有效", "run"],
		["仅此次调用", "once"],
		["拒绝", "deny"],
		["允许本会话完全相同的请求", "deny"],
	] as const) {
		expect(
			await chooseToolAccess(
				request,
				async () => answer,
				async () => {},
			),
		).toBe(expected);
	}
});

test("choosing the initial tool access option grants only the submitted invocation", async () => {
	const decision = await chooseToolAccess(
		{ tool: "write", reason: "保存结果", arguments: { path: "report.txt", content: "ok" } },
		async (_title, choices) => choices[0],
		async () => {},
	);
	expect(decision).toBe("once");
});

test("tool request titles and details bound untrusted data and hide credentials after stripping escapes", async () => {
	const request = {
		tool: "write\x1b[2J\t",
		reason: "保存 sk-\x1b[31mFAKE_REASON\t" + "reason\n".repeat(500),
		arguments: { token: "FAKE_TOKEN", content: "sk-\x1b[31mFAKE_CONTENT\t" + "line\n".repeat(500) },
	};
	const answers = ["查看申请详情（只读）", "拒绝"];
	const visible: string[] = [];
	await chooseToolAccess(
		request,
		async title => {
			visible.push(title);
			return answers.shift();
		},
		async body => {
			visible.push(body);
		},
	);
	for (const body of visible) {
		expect(body).not.toMatch(/[\x1b\t]/);
		expect(body).not.toMatch(/FAKE_REASON|FAKE_TOKEN|FAKE_CONTENT/);
		expect(body.length).toBeLessThan(9_000);
		expect(body).toContain("目录");
		expect(body).toContain("联网");
		expect(body).toContain("计划模式");
		expect(body).toContain("审批");
	}
});

test("a long application reason cannot hide the real invocation arguments from details", async () => {
	const answers = ["查看申请详情（只读）", "拒绝"];
	let details = "";
	await chooseToolAccess(
		{
			tool: "write",
			reason: "reason ".repeat(1_100),
			arguments: { path: "actual-report.txt", content: "actual result" },
		},
		async () => answers.shift(),
		async body => {
			details = body;
		},
	);
	expect(details).toContain("actual-report.txt");
	expect(details).toContain("actual result");
	expect(details.length).toBeLessThan(9_000);
});

test("tools list works without interactive UI and distinguishes baseline, temporary and disabled tools", async () => {
	const f = await accessFixture();
	try {
		f.access.grant("write");
		const menu = menuContext({ hasUI: false });
		for (const command of ["", "list"]) {
			await toolsFromCommand(f.state, menu.ctx, command, () => {
				throw new Error("只读状态不要求空闲");
			});
		}
		const body = menu.documents.join("\n");
		expect(body).toMatch(/基线启用[^\n]*read|read[^\n]*基线启用/);
		expect(body).toMatch(/临时启用[^\n]*write|write[^\n]*临时启用/);
		expect(body).toMatch(/关闭[^\n]*edit|edit[^\n]*关闭/);
		expect(body).toContain("重启");
		expect(body).toContain("切换预设");
	} finally {
		await f.close();
	}
});

test("noninteractive tool management never changes capabilities", async () => {
	const f = await accessFixture();
	try {
		f.access.grant("edit");
		for (const command of ["allow write", "revoke edit", "clear"]) {
			const menu = menuContext({ hasUI: false });
			await expect(toolsFromCommand(f.state, menu.ctx, command, () => {})).rejects.toThrow("交互");
			expect(f.access.allows("write")).toBe(false);
			expect(f.access.allows("edit")).toBe(true);
		}
	} finally {
		await f.close();
	}
});

test("human allow offers only run scope and keeps the saved resource selection intact", async () => {
	const f = await accessFixture();
	try {
		const before = structuredClone(f.state.config);
		const menu = menuContext({ answers: ["本次Agent运行有效"] });
		let checks = 0;
		await toolsFromCommand(f.state, menu.ctx, "allow write", () => checks++);
		expect(f.access.allows("write")).toBe(true);
		expect(f.access.allows("edit")).toBe(false);
		expect(f.state.config).toEqual(before);
		expect(checks).toBeGreaterThanOrEqual(2);
		expect(menu.selections[0].choices).not.toContain("仅此次调用");
		expect(menu.selections[0].title).toContain("审批");
	} finally {
		await f.close();
	}
});

test("cancelling a manual allow leaves the tool disabled", async () => {
	const f = await accessFixture();
	try {
		const menu = menuContext({ answers: [undefined] });
		await toolsFromCommand(f.state, menu.ctx, "allow write", () => {});
		expect(f.access.allows("write")).toBe(false);
	} finally {
		await f.close();
	}
});

test("an idle change while selecting prevents a manual grant", async () => {
	const f = await accessFixture();
	try {
		let busy = false;
		const menu = menuContext({
			answers: ["本次Agent运行有效"],
			onSelect: () => {
				busy = true;
			},
		});
		await expect(
			toolsFromCommand(f.state, menu.ctx, "allow write", () => {
				if (busy) throw new Error("会话仍在运行");
			}),
		).rejects.toThrow("仍在运行");
		expect(f.access.allows("write")).toBe(false);
	} finally {
		await f.close();
	}
});

test("cancellation while selecting prevents manual capability changes", async () => {
	const f = await accessFixture();
	try {
		const abort = new AbortController();
		const menu = menuContext({ answers: ["本次Agent运行有效"], signal: abort.signal, onSelect: () => abort.abort() });
		await expect(toolsFromCommand(f.state, menu.ctx, "allow write", () => {})).rejects.toThrow();
		expect(f.access.allows("write")).toBe(false);
	} finally {
		await f.close();
	}
});

test("cancelling a pending management dialog closes it without waiting for a human choice", async () => {
	const f = await accessFixture();
	const pending = Promise.withResolvers<string | undefined>();
	try {
		const entered = Promise.withResolvers<void>();
		const abort = new AbortController();
		const menu = menuContext({ signal: abort.signal });
		menu.ctx.ui.select = (_title, _choices, options) => {
			entered.resolve();
			return untilAborted(options?.signal, pending.promise);
		};
		const task = toolsFromCommand(f.state, menu.ctx, "allow write", () => {}).then(
			() => "resolved",
			() => "aborted",
		);
		await entered.promise;
		abort.abort();
		const result = await Promise.race([task, Bun.sleep(50).then(() => "pending")]);
		pending.resolve(undefined);
		await task;
		expect(result).toBe("aborted");
		expect(f.access.allows("write")).toBe(false);
	} finally {
		pending.resolve(undefined);
		await f.close();
	}
});

test("tool status identifies task cleanup access separately from unrestricted temporary tools", async () => {
	const f = await accessFixture();
	const entries = f.access.list().map(entry => ({
		...entry,
		enabled: entry.name === "job_output" ? false : entry.enabled,
		scoped: entry.name === "job_output",
	}));
	const status = spyOn(f.access, "list").mockReturnValue(entries);
	try {
		const menu = menuContext({ hasUI: false });
		await toolsFromCommand(f.state, menu.ctx, "list", () => {});
		const body = menu.documents.join("\n");
		const job = body.split("\n").find(line => line.includes("job_output"));
		expect(job).toContain("任务收尾（仅关联任务）");
		expect(job).not.toContain("临时启用");
		expect(job).not.toContain("关闭");
		expect(body).toContain("撤销运行期授权不影响已有任务收尾");
	} finally {
		status.mockRestore();
		await f.close();
	}
});

test("revoking a temporary grant removes access while baseline tools stay enabled", async () => {
	const f = await accessFixture();
	try {
		f.access.grant("write");
		const menu = menuContext({ answers: ["撤销临时授权", "撤销临时授权"] });
		await toolsFromCommand(f.state, menu.ctx, "revoke write", () => {});
		expect(f.access.allows("write")).toBe(false);
		await toolsFromCommand(f.state, menu.ctx, "revoke read", () => {});
		expect(f.access.allows("read")).toBe(true);
		expect(menu.notifications.join("\n")).toContain("基线");
	} finally {
		await f.close();
	}
});

test("clear requires confirmation and removes only temporary capabilities", async () => {
	const f = await accessFixture();
	try {
		f.access.grant("write");
		f.access.grant("edit");
		const menu = menuContext({ answers: [undefined, "撤销全部临时授权"] });
		await toolsFromCommand(f.state, menu.ctx, "clear", () => {});
		expect(f.access.allows("write")).toBe(true);
		await toolsFromCommand(f.state, menu.ctx, "clear", () => {});
		expect(f.access.allows("write")).toBe(false);
		expect(f.access.allows("edit")).toBe(false);
		expect(f.access.allows("read")).toBe(true);
	} finally {
		await f.close();
	}
});

test("the tools menu selects a disabled tool and returns without granting other tools", async () => {
	const f = await accessFixture();
	try {
		const menu = menuContext({
			answers: [
				"临时启用工具",
				choices => choices.find(choice => choice.includes("write")),
				"本次Agent运行有效",
				"返回",
			],
		});
		await toolsFromCommand(f.state, menu.ctx, "", () => {});
		expect(f.access.allows("write")).toBe(true);
		expect(f.access.allows("edit")).toBe(false);
	} finally {
		await f.close();
	}
});
