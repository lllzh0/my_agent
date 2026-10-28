import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxManager } from "@my-agent/windows-sandbox";
import * as status from "../src/processes/sandbox-status";
import { WindowsSandbox } from "../src/processes/windows-sandbox";

afterEach(() => vi.restoreAllMocks());

test("cancelling Windows initialization stops that command while another waiter can continue", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "windows-sandbox-cancel-"));
	const entered = Promise.withResolvers<void>();
	const initialized = Promise.withResolvers<void>();
	spyOn(status, "windowsSandboxDependencies").mockResolvedValue({ errors: [], warnings: [] });
	const initialize = spyOn(SandboxManager, "initialize").mockImplementation(async () => {
		entered.resolve();
		await initialized.promise;
	});
	const wrap = spyOn(SandboxManager, "wrapWithSandboxArgv").mockResolvedValue({
		argv: ["sandbox-helper", "--", "powershell.exe", "command"],
		env: {},
	});
	spyOn(SandboxManager, "reset").mockResolvedValue();
	const sandbox = new WindowsSandbox(root, root, root, [], [], [], []);
	const controller = new AbortController();
	const cancelled = sandbox.prepare("Write-Output CANCELLED_COMMAND", controller.signal).then(
		() => "executed",
		() => "cancelled",
	);
	let continued: Promise<unknown> | undefined;
	try {
		await entered.promise;
		continued = sandbox.prepare("Write-Output CONTINUING_COMMAND");
		controller.abort();
		const outcome = await Promise.race([cancelled, Bun.sleep(100).then(() => "still-waiting")]);
		expect(outcome).toBe("cancelled");
		expect(wrap).not.toHaveBeenCalled();
		initialized.resolve();
		await continued;
		expect(initialize).toHaveBeenCalledTimes(1);
		expect(wrap).toHaveBeenCalledTimes(1);
		expect(wrap.mock.calls[0]![0]).toContain("CONTINUING_COMMAND");
		expect(wrap.mock.calls[0]![0]).not.toContain("CANCELLED_COMMAND");
	} finally {
		initialized.resolve();
		await Promise.allSettled([cancelled, continued]);
		await sandbox.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});
