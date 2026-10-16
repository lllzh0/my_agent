import { atomicJson, readJson } from "../storage.ts";

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";
export interface Task {
	title: string;
	status: TaskStatus;
	evidence?: string;
}
export class Workflow {
	readonly path: string;
	tasks: Task[] = [];
	constructor(path: string) {
		this.path = path;
	}
	async load(): Promise<void> {
		const value = await readJson(this.path);
		if (Array.isArray(value)) this.tasks = value as Task[];
	}
	async replace(titles: string[]): Promise<void> {
		if (titles.length > 20 || titles.some(x => !x.trim() || x.length > 300))
			throw new Error("任务须为 1–300 字，最多 20 项");
		this.tasks = titles.map(title => ({ title, status: "pending" }));
		await atomicJson(this.path, this.tasks);
	}
	async update(index: number, status: TaskStatus, evidence?: string): Promise<void> {
		if (!this.tasks[index]) throw new Error("任务不存在");
		if (!["pending", "in_progress", "completed", "blocked"].includes(status)) throw new Error("任务状态无效");
		if (status === "completed" && !evidence?.trim()) throw new Error("完成任务必须提供结果或检查证据");
		this.tasks[index] = { ...this.tasks[index], status, evidence };
		await atomicJson(this.path, this.tasks);
	}
}
