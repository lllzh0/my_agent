import { expect, test } from "bun:test";
import * as path from "node:path";
import { fixture } from "./helpers";

test("the model can search beyond 500 files using native regex and file globs", async () => {
	const f = await fixture();
	try {
		await Promise.all(
			Array.from({ length: 620 }, (_, index) =>
				Bun.write(
					path.join(f.cwd, String(index).padStart(4, "0") + ".ts"),
					index === 619 ? "NATIVE_731\n" : "ordinary\n",
				),
			),
		);
		await Bun.write(path.join(f.cwd, "ignored.ts"), "NATIVE_999\n");
		await Bun.write(path.join(f.cwd, ".gitignore"), "ignored.ts\n");
		f.callTool("grep", { pattern: "^NATIVE_[0-9]+$", glob: "*.ts" });
		const run = await f.run();
		expect(run.code, run.stderr).toBe(0);
		const output = run.result.messages.find(
			(message: { role: string; toolName?: string }) => message.role === "toolResult" && message.toolName === "grep",
		);
		expect(output.isError).not.toBe(true);
		const found = JSON.parse(output.content[0].text);
		expect(found.matches.map((row: { path: string; line: string }) => [row.path, row.line])).toEqual([
			["0619.ts", "NATIVE_731"],
		]);
		expect(found.complete).toBe(true);
	} finally {
		await f.close();
	}
}, 30000);

test("the model can continue and search a stored long source after resuming", async () => {
	const f = await fixture();
	try {
		await Bun.write(path.join(f.cwd, "long.txt"), "A".repeat(12000) + "TAIL_EVIDENCE");
		f.callTools([
			{ name: "read_document", arguments: { path: "long.txt" } },
			{ name: "read_source", arguments: { sourceId: "S1", offset: 12001, limit: 100 } },
			{ name: "search_source", arguments: { sourceId: "S1", query: "TAIL_EVIDENCE" } },
		]);
		const run = await f.run();
		expect(run.code, run.stderr).toBe(0);
		const outputs = run.result.messages.filter((message: { role: string }) => message.role === "toolResult");
		expect(outputs.some((output: { isError?: boolean }) => output.isError)).toBe(false);
		const initial = JSON.parse(outputs[0].content[0].text);
		const continued = JSON.parse(outputs[1].content[0].text);
		const searched = JSON.parse(outputs[2].content[0].text);
		expect(initial.text).not.toContain("TAIL_EVIDENCE");
		expect(initial.range.nextOffset).toBe(12001);
		expect(continued.text).toBe("TAIL_EVIDENCE");
		expect(searched.matches[0].offset).toBe(12001);
		const resumed = await f.run({
			resume: run.result.sessionFile,
			action: "commands",
			commands: ["/session"],
		});
		expect(resumed.code, resumed.stderr).toBe(0);
		const info = JSON.parse(resumed.result.displays[0].text);
		expect(info.storage.sources.sourceCount).toBe(1);
	} finally {
		await f.close();
	}
}, 30000);

test("CLI full access writes outside the workspace and a new process returns to manual", async () => {
	const f = await fixture();
	try {
		const external = path.join(f.root, "outside.txt");
		f.callTool("write", { path: external, content: "EXPLICIT_FULL_ACCESS" });
		const full = await f.cli(["--permissions", "full"]);
		expect(full.code, full.stderr).toBe(0);
		expect(await Bun.file(external).text()).toBe("EXPLICIT_FULL_ACCESS");
		f.callTool("write", { path: external, content: "MUST_NOT_REPLACE" });
		const manual = await f.cli([]);
		expect(manual.code, manual.stderr).toBe(0);
		expect(await Bun.file(external).text()).toBe("EXPLICIT_FULL_ACCESS");
		const saved = await Bun.file(path.join(f.home, "config.json")).json();
		expect(saved.permissions.approval).not.toBe("full");
	} finally {
		await f.close();
	}
}, 30000);

test("CLI auto permits ordinary file writes and rejects unknown permission modes", async () => {
	const f = await fixture();
	try {
		f.callTool("write", { path: "auto.txt", content: "AUTO_CLI_OK" });
		const invalid = await f.cli(["--permissions", "anything"]);
		expect(invalid.code).toBe(1);
		expect(f.requests).toHaveLength(0);
		expect(await Bun.file(path.join(f.cwd, "auto.txt")).exists()).toBe(false);
		const auto = await f.cli(["--permissions", "auto"]);
		expect(auto.code, auto.stderr).toBe(0);
		expect(await Bun.file(path.join(f.cwd, "auto.txt")).text()).toBe("AUTO_CLI_OK");
	} finally {
		await f.close();
	}
}, 30000);
