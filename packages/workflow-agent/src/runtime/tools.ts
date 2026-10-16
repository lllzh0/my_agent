import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { EditTool, replaceEditSchema } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/sdk";
import { Type } from "@oh-my-pi/omptype/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunState } from "./state";
import { digest } from "../storage";
import { toolDescriptions } from "./tool-prompts";
import readDescription from "../prompts/tool-read.md" with { type: "text" };
import mcpListDescription from "../prompts/tool-mcp-list.md" with { type: "text" };
import mcpCallDescription from "../prompts/tool-mcp-call.md" with { type: "text" };
const { readdir, readFile } = fs;
const { join } = path;

export const result = (value: unknown) => ({
	content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
	details: {},
});

// Native file tools interpret URI, selector, wildcard and multi-path syntax.
// Resolve only plain paths so their eventual target matches our policy check.
function plainPath(value: string): string {
	if ([";", ":", "[", "]", "*", "?", "\0", "\r", "\n"].some(character => value.includes(character)))
		throw new Error("文件工具只接受普通路径；行范围请使用 offset 和 limit，不接受内联选择器或通配符。");
	return value;
}

export function productTools(state: RunState, context: ToolSession): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	const pi: Pick<ExtensionAPI, "registerTool"> = {
		registerTool(tool) {
			// Schemas remain attached to each heterogeneous definition; OMP validates
			// their arguments before dispatching these callbacks.
			tools.push({ ...tool, loadMode: "essential" } as unknown as ToolDefinition);
		},
	};
	const { policy, journal, research, jobs, workflow } = state;
	pi.registerTool({
		name: "mcp_list",
		label: "MCP 服务与工具",
		description: mcpListDescription,
		parameters: Type.Object({ server: Type.Optional(Type.String()) }),
		async execute(_id, input, signal) {
			return result(await state.mcp.list(input.server, signal));
		},
	});
	pi.registerTool({
		name: "mcp_call",
		label: "调用 MCP 工具",
		description: mcpCallDescription,
		parameters: Type.Object({
			server: Type.String(),
			tool: Type.String(),
			arguments: Type.Record(Type.String(), Type.Unknown()),
		}),
		async execute(_id, input, signal) {
			return result(await state.mcp.call(input.server, input.tool, input.arguments, signal));
		},
	});
	// The native client bridge receives the final text after replacement. Check
	// that result before disk IO so an edit cannot outgrow its recovery snapshot.
	const fileBridge: ClientBridge = {
		capabilities: { writeTextFile: true },
		async writeTextFile({ path, content }) {
			if (Buffer.byteLength(content) > 1_000_000 || content.includes("\0"))
				throw new Error("直接文件修改只支持 1MB 以下的文本内容");
			const target = plainPath(await policy.resolvePath(plainPath(path), "write"));
			policy.checkMode({ tool: "file", kind: "write", target });
			await Bun.write(target, content);
		},
	};
	const fileContext: ToolSession = { ...context, getClientBridge: () => fileBridge };
	const read = new ReadTool(fileContext);
	const write = new WriteTool(fileContext);
	const edit = new EditTool(fileContext, "replace");
	pi.registerTool({
		name: "read",
		label: "读取文件",
		description: readDescription,
		parameters: Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
		}),
		approval: "read",
		async execute(id, input, signal, update) {
			const path = plainPath(await policy.resolvePath(plainPath(input.path), "read"));
			await policy.authorize({ tool: "read", kind: "read", target: path });
			await fs.stat(path);
			const start = input.offset ?? 1;
			const selector =
				input.offset !== undefined || input.limit !== undefined
					? `:${start}-${start + (input.limit ?? 200) - 1}`
					: "";
			const output = await read.execute(id, { path: path + selector }, signal, update);
			for (const entry of state.resources.entries)
				if (entry.kind === "skill" && entry.path === path) entry.bodyLoaded = true;
			return output;
		},
	});
	pi.registerTool({
		name: "write",
		label: "写入文件",
		description: write.description,
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		approval: "write",
		async execute(id, input, signal, update) {
			if (Buffer.byteLength(input.content) > 1_000_000 || input.content.includes("\0"))
				throw new Error("直接文件修改只支持 1MB 以下的文本内容");
			const path = plainPath(await policy.resolvePath(plainPath(input.path), "write"));
			await policy.authorize({
				tool: "write",
				kind: "write",
				target: path,
				parameters: { contentHash: digest(input.content), preview: input.content.slice(0, 2000) },
			});
			return journal.capture(state.turn, path, () => write.execute(id, { ...input, path }, signal, update));
		},
	});
	pi.registerTool({
		name: "edit",
		label: "编辑文件",
		description: edit.description,
		parameters: replaceEditSchema,
		approval: "write",
		async execute(id, input, signal, update) {
			if (Buffer.byteLength(input.new_string) > 1_000_000 || input.new_string.includes("\0"))
				throw new Error("直接文件修改只支持 1MB 以下的文本内容");
			const path = plainPath(await policy.resolvePath(plainPath(input.path), "write"));
			await policy.authorize({
				tool: "edit",
				kind: "write",
				target: path,
				parameters: {
					editsHash: digest(JSON.stringify(input)),
					before: input.old_string.slice(0, 1000),
					after: input.new_string.slice(0, 1000),
					replaceAll: input.replace_all === true,
				},
			});
			return journal.capture(state.turn, path, () => edit.execute(id, { ...input, path }, signal, update));
		},
	});
	pi.registerTool({
		name: "bash",
		label: "运行命令",
		description: toolDescriptions.description0,
		parameters: Type.Object({
			command: Type.String(),
			background: Type.Optional(Type.Boolean()),
			timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 1200 })),
		}),
		async execute(_id, input, signal) {
			const job = await jobs.start(input.command, {
				timeoutMs: (input.timeout ?? 120) * 1000,
				signal: input.background ? undefined : signal,
			});
			return result(input.background ? job : await jobs.wait(job.id));
		},
	});
	const walk = async (path: string, signal?: AbortSignal): Promise<string[]> => {
		const files: string[] = [];
		const queue = [path];
		while (queue.length && files.length < 2000) {
			if (signal?.aborted) throw new Error("文件查找已取消");
			const current = queue.shift()!;
			for (const entry of await readdir(current, { withFileTypes: true })) {
				if ([".git", "node_modules", ".my-agent", ".cache"].includes(entry.name) || entry.isSymbolicLink())
					continue;
				const target = join(current, entry.name);
				try {
					await policy.resolvePath(target, "read");
				} catch {
					continue;
				}
				if (entry.isDirectory()) queue.push(target);
				else if (entry.isFile()) files.push(target);
			}
		}
		return files;
	};
	for (const name of ["grep", "find", "ls"] as const)
		pi.registerTool({
			name,
			label: name === "grep" ? "搜索文件内容" : name === "find" ? "查找文件" : "目录列表",
			description: name === "grep" ? toolDescriptions.grep : toolDescriptions.find,
			parameters: Type.Object({ path: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()) }),
			async execute(_id, input, signal) {
				const path = await policy.resolvePath(input.path ?? ".", "read");
				await policy.authorize({ tool: name, kind: "read", target: path });
				if (name === "ls")
					return result(
						(await readdir(path, { withFileTypes: true }))
							.filter(x => !x.name.startsWith(".env"))
							.map(x => `${x.name}${x.isDirectory() ? "/" : ""}`)
							.slice(0, 200),
					);
				const files = await walk(path, signal);
				if (name === "find")
					return result(files.filter(file => !input.pattern || file.includes(input.pattern)).slice(0, 100));
				if (!input.pattern) throw new Error("grep 需要非空 pattern（字面文本）");
				const matches: string[] = [];
				for (const file of files.slice(0, 500)) {
					const bytes = await readFile(file);
					if (bytes.length > 1_000_000 || bytes.includes(0)) continue;
					bytes
						.toString("utf8")
						.split("\n")
						.forEach((line, index) => {
							if (matches.length < 100 && line.includes(input.pattern!))
								matches.push(`${file}:${index + 1}: ${line.slice(0, 500)}`);
						});
				}
				return result(matches);
			},
		});
	pi.registerTool({
		name: "web_search",
		label: "联网搜索",
		description: toolDescriptions.description1,
		parameters: Type.Object({ query: Type.String() }),
		async execute(_id, input, signal) {
			await policy.authorize({
				tool: "web_search",
				kind: "network",
				target: "https://api.tavily.com/search",
				parameters: { query: input.query },
			});
			return result(await research.search(input.query, signal));
		},
	});
	pi.registerTool({
		name: "web_fetch",
		label: "读取网页",
		description: toolDescriptions.description2,
		parameters: Type.Object({ url: Type.String() }),
		async execute(_id, input, signal) {
			await policy.authorize({ tool: "web_fetch", kind: "network", target: input.url });
			const source = await research.fetch(input.url, signal);
			return result({
				...source,
				text: source.text.slice(0, 12_000),
				pages: source.pages?.map(x => ({ ...x, text: x.text.slice(0, 500) })),
			});
		},
	});
	pi.registerTool({
		name: "read_document",
		label: "读取资料",
		description: toolDescriptions.description3,
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, input, signal) {
			const path = await policy.resolvePath(input.path, "read");
			await policy.authorize({ tool: "read_document", kind: "read", target: path });
			const source = await research.document(path, signal);
			return result({ ...source, text: source.text.slice(0, 12_000) });
		},
	});
	pi.registerTool({
		name: "write_report",
		label: "保存研究报告",
		description: toolDescriptions.description4,
		parameters: Type.Object({
			path: Type.String(),
			claims: Type.Array(
				Type.Object({
					text: Type.String(),
					sourceIds: Type.Array(Type.String()),
					inference: Type.Optional(Type.Boolean()),
				}),
			),
		}),
		async execute(id, input, signal, update) {
			const content = research.report(input.claims);
			const path = plainPath(await policy.resolvePath(plainPath(input.path), "write"));
			await policy.authorize({
				tool: "write_report",
				kind: "write",
				target: path,
				parameters: { contentHash: digest(content), preview: content.slice(0, 2000) },
			});
			return journal.capture(state.turn, path, () => write.execute(id, { path, content }, signal, update));
		},
	});
	pi.registerTool({
		name: "task_list",
		label: "任务列表",
		description: toolDescriptions.description5,
		parameters: Type.Object({ titles: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, input) {
			if (input.titles) await workflow.replace(input.titles);
			return result(workflow.tasks);
		},
	});
	pi.registerTool({
		name: "task_update",
		label: "更新进度",
		description: toolDescriptions.description6,
		parameters: Type.Object({
			index: Type.Number(),
			status: Type.Union([
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("completed"),
				Type.Literal("blocked"),
			]),
			evidence: Type.Optional(Type.String()),
		}),
		async execute(_id, input) {
			await workflow.update(input.index, input.status, input.evidence);
			return result(workflow.tasks);
		},
	});
	pi.registerTool({
		name: "ask_user",
		label: "询问用户",
		description: toolDescriptions.description7,
		parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, input, _signal, _update, ctx: ExtensionContext) {
			if (!ctx.hasUI) throw new Error("需要用户回答；当前非交互模式无法继续该问题");
			const answer = input.options?.length
				? await ctx.ui.select(input.question, [...input.options.slice(0, 4), "输入自己的回答"])
				: await ctx.ui.input(input.question);
			if (!answer) throw new Error("问题未获回答，不能推定批准");
			return result(answer === "输入自己的回答" ? ((await ctx.ui.input(input.question)) ?? "未回答") : answer);
		},
	});
	pi.registerTool({
		name: "job_output",
		label: "后台输出",
		description: toolDescriptions.description8,
		parameters: Type.Object({ id: Type.String(), cursor: Type.Optional(Type.Number()) }),
		async execute(_id, input) {
			return result(jobs.output(input.id, input.cursor));
		},
	});
	pi.registerTool({
		name: "job_stop",
		label: "停止后台任务",
		description: toolDescriptions.description9,
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, input) {
			await jobs.stop(input.id);
			return result(jobs.list());
		},
	});
	return tools;
}
