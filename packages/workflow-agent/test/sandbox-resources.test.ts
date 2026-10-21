import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Sandbox } from "../src/processes/sandbox";

afterEach(() => vi.restoreAllMocks());

(process.platform === "darwin" ? test : test.skip)(
	"commands use changed resource read roots even after the sandbox has warmed up",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-sandbox-"));
		try {
			const workspace = path.join(root, "workspace");
			const home = path.join(root, "home");
			const first = path.join(root, "first");
			const second = path.join(root, "second");
			await Promise.all([workspace, home, first, second].map(dir => fs.mkdir(dir)));
			let config: SandboxRuntimeConfig | undefined;
			spyOn(SandboxManager, "checkDependencies").mockReturnValue({ errors: [], warnings: [] });
			spyOn(SandboxManager, "initialize").mockImplementation(async value => {
				config = value;
			});
			spyOn(SandboxManager, "getConfig").mockImplementation(() => config);
			const effective: SandboxRuntimeConfig[] = [];
			spyOn(SandboxManager, "wrapWithSandbox").mockImplementation(async (_command, _shell, override) => {
				effective.push({ ...config!, ...override });
				return "/usr/bin/sandbox-exec -p '(version 1)' /bin/bash -c true";
			});
			const roots = [first];
			const sandbox = new Sandbox(workspace, home, [], roots);
			await sandbox.wrap("true");
			roots.splice(0, roots.length, second);
			await sandbox.wrap("true");
			await sandbox.wrap("true", undefined, { gitWrite: true });
			expect(effective[0].filesystem.allowRead).toContain(await fs.realpath(first));
			expect(effective[1].filesystem.allowRead).toContain(await fs.realpath(second));
			expect(effective[1].filesystem.allowRead).not.toContain(await fs.realpath(first));
			expect(effective[1].filesystem.denyWrite).toEqual(effective[0].filesystem.denyWrite);
			expect(effective[2].filesystem.allowRead).toEqual(effective[1].filesystem.allowRead);
			expect(effective[2].filesystem.denyWrite).not.toContain(path.join(await fs.realpath(workspace), ".git"));
			expect(effective[2].filesystem.denyWrite).toContain(path.join(await fs.realpath(workspace), ".agents"));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);
