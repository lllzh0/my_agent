#!/usr/bin/env bun
import { $ } from "bun";
import * as path from "node:path";
import { installNativeArchive, nativeTarget, nativeRelease } from "../src/distribution/native";

const root = path.resolve(import.meta.dir, "../../..");
try {
	const target = nativeTarget();
	if (!Bun.semver.satisfies(Bun.version, ">=1.3.14")) throw new Error("需要 Bun 1.3.14 或更新版本");
	const natives = (await Bun.file(path.join(root, "packages/natives/package.json")).json()) as { version: string };
	const agent = (await Bun.file(path.join(root, "packages/coding-agent/package.json")).json()) as { version: string };
	if (natives.version !== agent.version || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(natives.version))
		throw new Error("OMP 与原生组件源码版本不一致，请先核对 checkout");
	console.log("安装锁定依赖（不执行依赖安装脚本）……");
	await $`${process.execPath} install --frozen-lockfile --ignore-scripts --filter @my-agent/workflow-agent --filter @oh-my-pi/collab-web --registry https://registry.npmjs.org --network-concurrency 8`.cwd(
		root,
	);
	console.log("生成 OMP 工具视图……");
	await $`${process.execPath} run gen:tool-views`.cwd(root);
	console.log(`准备官方原生组件 ${natives.version}……`);
	const response = await fetch(`https://registry.npmjs.org/${target.packageName}/${natives.version}`, {
		redirect: "error",
		signal: AbortSignal.timeout(60000),
	});
	if (!response.ok) throw new Error(`原生发行元数据获取失败：HTTP ${response.status}`);
	const metadata: unknown = await response.json();
	const release = nativeRelease(metadata, natives.version);
	const archive = await fetch(release.tarball, { redirect: "error", signal: AbortSignal.timeout(60000) });
	if (!archive.ok) throw new Error(`原生归档下载失败：HTTP ${archive.status}`);
	const bytes = new Uint8Array(await archive.arrayBuffer());
	if (bytes.byteLength > 256_000_000) throw new Error("原生归档超过 256MB 上限");
	await installNativeArchive(root, natives.version, metadata, bytes);
	await $`${process.execPath} --no-env-file -e ${'import { __piNativesBuildVersion } from "./packages/natives/native/index.js"; const version=__piNativesBuildVersion(); if(version!==process.env.MY_AGENT_EXPECTED_NATIVE_VERSION) throw new Error("Native build version mismatch"); console.log("原生组件版本已验证："+version);'}`
		.cwd(root)
		.env({ ...process.env, MY_AGENT_EXPECTED_NATIVE_VERSION: natives.version });
	console.log("源码准备完成。运行 bun run agent doctor 检查环境，bun run agent --demo 离线试用。");
	if (process.platform === "win32")
		console.log(
			"Windows 命令隔离还需一次系统安装：bun run agent:sandbox install；查询状态用 bun run agent:sandbox status。",
		);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
