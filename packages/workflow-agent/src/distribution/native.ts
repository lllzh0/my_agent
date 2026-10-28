import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface NativeTarget {
	packageName: string;
	addonFilename: string;
}

export function nativeTarget(platform: NodeJS.Platform = process.platform, arch = process.arch): NativeTarget {
	if (!(platform === "darwin" && arch === "arm64") && !(platform === "win32" && ["x64", "arm64"].includes(arch)))
		throw new Error(`源码准备暂不支持 ${platform}-${arch}；当前支持 macOS arm64 和 Windows x64/arm64。`);
	const tag = `${platform}-${arch}`;
	return {
		packageName: `@oh-my-pi/pi-natives-${tag}`,
		addonFilename: `pi_natives.${tag}${platform === "win32" && arch === "x64" ? "-baseline" : ""}.node`,
	};
}

export function nativeTar(): string {
	const command = process.platform === "win32" ? Bun.which("tar.exe") : "/usr/bin/tar";
	if (!command) throw new Error("找不到系统 tar.exe；Windows 10 1803+ 提供该工具，请检查 PATH。");
	return command;
}

export function nativeRelease(
	input: unknown,
	version: string,
	target = nativeTarget(),
): { tarball: string; integrity: string } {
	if (!input || typeof input !== "object") throw new Error("原生发行元数据无效");
	const value = input as Record<string, unknown>;
	if (value.name !== target.packageName || value.version !== version) throw new Error("原生组件名称或版本不匹配");
	if (!value.dist || typeof value.dist !== "object") throw new Error("原生发行缺少下载信息");
	const dist = value.dist as Record<string, unknown>;
	if (
		typeof dist.tarball !== "string" ||
		typeof dist.integrity !== "string" ||
		!/^sha512-[A-Za-z0-9+/]+=*$/.test(dist.integrity)
	)
		throw new Error("原生发行缺少 SHA-512 完整性信息");
	const url = new URL(dist.tarball);
	if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash)
		throw new Error("原生组件只接受官方 npm registry 的 HTTPS 归档");
	return { tarball: url.href, integrity: dist.integrity };
}

/** Verify the official archive, then copy only the expected addon into this checkout. */
export async function installNativeArchive(
	root: string,
	version: string,
	metadata: unknown,
	bytes: Uint8Array,
	target = nativeTarget(),
): Promise<string> {
	const release = nativeRelease(metadata, version, target);
	const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
	if (integrity !== release.integrity) throw new Error("原生归档完整性校验失败；现有组件未修改");
	const checkout = await fs.realpath(root);
	let directory = checkout;
	for (const component of ["packages", "natives", "native"]) {
		const next = path.join(directory, component);
		try {
			await fs.mkdir(next);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		directory = await fs.realpath(next);
		const relative = path.relative(checkout, directory);
		if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
			throw new Error("原生输出目录超出 checkout 范围");
	}
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-native-archive-"));
	const destination = path.join(directory, target.addonFilename);
	const staged = `${destination}.${randomUUID()}.tmp`;
	try {
		const archive = path.join(temporary, "native.tgz");
		await Bun.write(archive, bytes);
		const child = Bun.spawn([nativeTar(), "-xOzf", archive, `package/${target.addonFilename}`], {
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(15000),
		});
		const [content, stderr, code] = await Promise.all([
			new Response(child.stdout).arrayBuffer(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0 || content.byteLength === 0) throw new Error(`原生归档缺少预期组件：${stderr.slice(0, 500)}`);
		await Bun.write(staged, content);
		await fs.rename(staged, destination);
		return destination;
	} finally {
		await fs.rm(staged, { force: true });
		await fs.rm(temporary, { recursive: true, force: true });
	}
}
