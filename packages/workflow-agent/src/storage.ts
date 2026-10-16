import * as fs from "node:fs/promises";
const { mkdir, readFile, rename, writeFile } = fs;
import * as path from "node:path";
const { dirname } = path;
import { randomUUID, createHash } from "node:crypto";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

export async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`);
	}
}

export function redact(value: unknown): unknown {
	if (typeof value === "string") {
		let text = value.replace(/(?:Bearer\s+|sk-)[\w.-]+/gi, "[REDACTED]");
		for (const [name, secret] of Object.entries(process.env)) {
			if (/KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL/i.test(name) && secret && secret.length >= 5)
				text = text.split(secret).join("[REDACTED]");
		}
		return text;
	}
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				/^(?:apiKey|authorization|password|token|secret)$/i.test(key) ? "[REDACTED]" : redact(entry),
			]),
		);
	return value;
}

export function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
	return value as Record<string, unknown>;
}
