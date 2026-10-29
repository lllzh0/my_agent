import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Policy } from "../policy/policy";

export type AccessKind = "tool" | "skill" | "mcp";
export type AccessDecision = "once" | "run" | "deny";

export interface AccessRequest {
	kind: AccessKind;
	key: string;
	fingerprint: string;
	label: string;
	reason: string;
	details: Record<string, unknown>;
}

export type AccessApprover = (request: AccessRequest) => Promise<AccessDecision>;

export interface AccessGrant {
	kind: AccessKind;
	key: string;
	fingerprint: string;
}

/** Host-local capabilities; their consumers must still enforce operation policies. */
export class TemporaryAccess {
	#policy: Policy;
	#grants = new Map<string, AccessGrant>();
	#approver: AccessApprover = async () => "deny";
	#kindApprovers = new Map<AccessKind, AccessApprover>();
	#approvalTail: Promise<void> = Promise.resolve();
	#invalidated = new AbortController();
	#revision = 0;
	#closed = false;
	#listeners = new Set<() => void>();

	constructor(policy: Policy) {
		this.#policy = policy;
	}

	setApprover(approver: AccessApprover, kind?: AccessKind): void {
		this.#assertOpen();
		this.#invalidate();
		if (kind === undefined) this.#approver = approver;
		else this.#kindApprovers.set(kind, approver);
		this.#notify();
	}

	/** Keep derived permissions in sync immediately when a shared grant changes. */
	subscribe(listener: () => void): () => void {
		this.#assertOpen();
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get signal(): AbortSignal {
		return this.#invalidated.signal;
	}

	get revision(): number {
		return this.#revision;
	}

	has(kind: AccessKind, key: string, fingerprint: string): boolean {
		return !this.#closed && this.#grants.get(this.#key(kind, key))?.fingerprint === fingerprint;
	}

	entries(kind?: AccessKind): AccessGrant[] {
		return [...this.#grants.values()]
			.filter(grant => kind === undefined || grant.kind === kind)
			.map(grant => ({ ...grant }));
	}

	grant(kind: AccessKind, key: string, fingerprint: string): void {
		this.#assertOpen();
		this.#grants.set(this.#key(kind, key), { kind, key, fingerprint });
		this.#notify();
	}

	revoke(kind?: AccessKind, key?: string): void {
		this.#invalidate();
		if (kind === undefined) this.#grants.clear();
		else if (key !== undefined) this.#grants.delete(this.#key(kind, key));
		else for (const [id, grant] of this.#grants) if (grant.kind === kind) this.#grants.delete(id);
		this.#notify();
	}

	async request(input: AccessRequest, signal?: AbortSignal): Promise<AccessDecision | "enabled"> {
		const request = structuredClone(input);
		const revision = this.#revision;
		const policyRevision = this.#policy.revision;
		const operationSignal = AbortSignal.any([this.signal, ...(signal ? [signal] : [])]);
		const assertCurrent = () => {
			operationSignal.throwIfAborted();
			this.#assertOpen();
			if (revision !== this.#revision) throw new Error("临时授权已变更，请重新申请");
			this.#policy.assertCurrent(policyRevision);
		};
		assertCurrent();
		if (this.has(request.kind, request.key, request.fingerprint)) return "enabled";
		// Keep the human callback in the queue even after the caller is cancelled.
		// The next prompt starts only once the actual previous callback settles.
		const approval = this.#approvalTail.then(async (): Promise<AccessDecision | "enabled"> => {
			assertCurrent();
			if (this.has(request.kind, request.key, request.fingerprint)) return "enabled";
			const approver = this.#kindApprovers.get(request.kind) ?? this.#approver;
			const decision = await approver(structuredClone(request));
			assertCurrent();
			if (decision === "run") this.grant(request.kind, request.key, request.fingerprint);
			return decision === "once" || decision === "run" ? decision : "deny";
		});
		this.#approvalTail = approval.then(
			() => undefined,
			() => undefined,
		);
		return untilAborted(operationSignal, approval);
	}

	close(): void {
		this.#closed = true;
		this.revoke();
		this.#kindApprovers.clear();
		this.#listeners.clear();
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}

	#key(kind: AccessKind, key: string): string {
		return JSON.stringify([kind, key]);
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("当前运行的临时授权入口已关闭");
	}

	#invalidate(): void {
		this.#revision++;
		this.#invalidated.abort(new Error("临时授权已变更，请重新申请"));
		if (!this.#closed) this.#invalidated = new AbortController();
	}
}
