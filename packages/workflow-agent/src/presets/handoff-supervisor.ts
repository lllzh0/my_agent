import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Subprocess } from "bun";
import {
	HandoffInbox,
	handoffDeadline,
	handoffMessage,
	type HandoffMessage,
	type HandoffSession,
	type PresetTarget,
} from "./handoff-protocol";
import { launchPreset } from "./defaults";
import { contained } from "../policy/paths";
import { readJson, record } from "../storage";

export interface HandoffPeer {
	done: Promise<number>;
	inbox: HandoffInbox;
	send(message: Omit<HandoffMessage, "token" | "version">): void;
	stop(): Promise<void>;
	allocated?: HandoffSession;
}
export interface HandoffLaunch {
	home: string;
	cwd: string;
	spawn(target: PresetTarget, prepared: boolean, receive: (message: HandoffMessage) => void): HandoffPeer;
	recoverCommand(session: HandoffSession): string;
	notify(message: string): void;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function validateHandoffSession(home: string, cwd: string, session: HandoffSession): Promise<void> {
	if ((await launchPreset(home, cwd, { resume: session.resume })) !== session.preset)
		throw new Error("交接会话不属于目标预设。");
	const manifest = record(await readJson(path.join(home, "state", session.id, "manifest.json")), "交接会话");
	if (manifest.sessionId !== session.id || manifest.cwd !== (await fs.realpath(cwd)))
		throw new Error("交接会话身份或工作区不匹配。");
	const stored = manifest.preset as { id?: string } | undefined;
	if ((stored?.id ?? "legacy") !== session.preset) throw new Error("交接预设身份不匹配。");
}

/** Terminal ownership changes only after source teardown and process exit both succeed. */
export async function superviseHandoffs(options: HandoffLaunch, initial: PresetTarget): Promise<number> {
	const timeout = options.timeoutMs ?? (process.platform === "win32" ? 150_000 : 45_000);
	let active: HandoffPeer;
	let cancelling: { id: string; controller: AbortController } | undefined;
	const peers = new Set<HandoffPeer>();
	const spawn = (target: PresetTarget, prepared: boolean) => {
		const peer = options.spawn(target, prepared, message => {
			if (peer === active && message.type === "cancel" && message.requestId === cancelling?.id)
				cancelling?.controller.abort(new Error("交接已取消，原会话保留。"));
		});
		peers.add(peer);
		return peer;
	};
	const wait = async (peer: HandoffPeer, expected: string, signal?: AbortSignal) => {
		const deadline = handoffDeadline(timeout, [
			...(signal ? [signal] : []),
			...(options.signal ? [options.signal] : []),
		]);
		try {
			for (;;) {
				const message = await peer.inbox.next(deadline.signal);
				if (message.type === "failed") throw new Error(message.error ?? "子进程交接失败。");
				if (message.type === expected) return message;
			}
		} finally {
			deadline.dispose();
		}
	};
	const discard = async (peer: HandoffPeer, target: PresetTarget, activated = false) => {
		await peer.stop();
		peers.delete(peer);
		const allocated = peer.allocated;
		if (activated || target.resume || !allocated) return;
		const root = await fs.realpath(options.home);
		const directory = path.resolve(root, "state", allocated.id);
		const sessions = path.resolve(
			root,
			...(target.preset === "legacy" ? ["sessions"] : ["presets", target.preset, "sessions"]),
		);
		if (
			!contained(path.resolve(root, "state"), directory) ||
			path.dirname(path.resolve(allocated.resume)) !== sessions ||
			!path.basename(allocated.resume).endsWith(`_${allocated.id}.jsonl`)
		)
			throw new Error("准备记录路径异常，未删除任何记录。");
		const parent = await fs.realpath(path.dirname(allocated.resume));
		const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (
			!contained(root, parent) ||
			(info && (info.isSymbolicLink() || !contained(root, await fs.realpath(directory))))
		)
			throw new Error("准备记录指向配置目录之外，未删除任何记录。");
		await fs.rm(allocated.resume, { force: true });
		await fs.rm(directory, { recursive: true, force: true });
	};
	const seen = new Set<string>();
	try {
		active = spawn(initial, false);
		await wait(active, "online");
		for (;;) {
			let request: HandoffMessage;
			try {
				request = await active.inbox.next(options.signal ?? new AbortController().signal);
			} catch {
				return await active.done;
			}
			if (
				request.type !== "request" ||
				!request.requestId ||
				!request.target ||
				!request.session ||
				seen.has(request.requestId)
			)
				continue;
			seen.add(request.requestId);
			if (seen.size > 100) seen.delete(seen.values().next().value!);
			const source = active;
			const sourceSession = request.session;
			const target = { ...request.target, plan: request.session.plan || request.target.plan };
			const controller = new AbortController();
			cancelling = { id: request.requestId, controller };
			const preparation = handoffDeadline(timeout, [controller.signal]);
			const signal = preparation.signal;
			let prepared: HandoffPeer | undefined;
			let closing = false;
			let activating = false;
			try {
				await validateHandoffSession(options.home, options.cwd, sourceSession);
				if (
					target.resume &&
					(await launchPreset(options.home, options.cwd, { resume: target.resume })) !== target.preset
				)
					throw new Error("目标历史不属于所选预设。");
				prepared = spawn(target, true);
				const ready = await wait(prepared, "prepared", signal);
				if (!ready.session || ready.session.preset !== target.preset) throw new Error("目标准备身份不一致。");
				await validateHandoffSession(options.home, options.cwd, ready.session);
				signal.throwIfAborted();
				closing = true;
				cancelling = undefined;
				source.send({ type: "close", requestId: request.requestId });
				const deadline = Promise.withResolvers<number>();
				const timer = setTimeout(() => deadline.reject(new Error("源进程未在期限内退出。")), timeout);
				let code: number;
				try {
					code = await Promise.race([
						source.done,
						wait(source, "closed").then(closed => {
							if (closed.requestId !== request.requestId) throw new Error("源会话清理确认不属于本次交接。");
							return source.done;
						}),
						deadline.promise,
					]);
				} finally {
					clearTimeout(timer);
				}
				if (code !== 0) throw new Error("原会话清理失败，未激活目标。");
				activating = true;
				prepared.send({ type: "activate" });
				await wait(prepared, "online");
				peers.delete(source);
				active = prepared;
			} catch (error) {
				if (prepared) await discard(prepared, target, activating);
				if (options.signal?.aborted) throw error;
				const detail = error instanceof Error ? error.message : String(error);
				if (!closing) {
					source.send({ type: "failed", requestId: request.requestId, error: detail.slice(0, 1900) });
				} else {
					await source.stop();
					peers.delete(source);
					options.notify(`交接失败，正在恢复原会话：${detail}`);
					try {
						active = spawn(sourceSession, false);
						await wait(active, "online");
					} catch (rollback) {
						options.notify(
							`原会话恢复失败：${String(rollback)}\n恢复命令：\n${options.recoverCommand(sourceSession)}`,
						);
						return 1;
					}
				}
			} finally {
				preparation.dispose();
				cancelling = undefined;
			}
		}
	} finally {
		await Promise.allSettled([...peers].map(peer => peer.stop()));
	}
}

export function processHandoffPeer(
	child: Subprocess<"inherit", "inherit", "inherit">,
	token: string,
	inbox: HandoffInbox,
): HandoffPeer {
	void child.exited.then(code => inbox.close(new Error(`会话子进程已退出（${code}）。`)));
	return {
		done: child.exited,
		inbox,
		send: message => child.send({ ...message, version: 1, token }),
		async stop() {
			if (child.exitCode !== null) return;
			child.kill("SIGTERM");
			const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
			if (!stopped) child.kill("SIGKILL");
			await child.exited;
		},
	};
}

export function receiveHandoff(
	peer: HandoffPeer,
	input: unknown,
	token: string,
	receive: (message: HandoffMessage) => void,
): void {
	const message = handoffMessage(input, token);
	if (!message) return;
	if (message.type === "allocated" && message.session) peer.allocated = message.session;
	receive(message);
	peer.inbox.put(message);
}
