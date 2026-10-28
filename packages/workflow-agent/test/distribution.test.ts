import { expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installNativeArchive, nativeTarget, nativeTar } from "../src/distribution/native";

async function archiveFixture(target = nativeTarget("darwin", "arm64")) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-native-dist-"));
	const source = path.join(root, "archive-source");
	const destination = path.join(root, "checkout");
	await Bun.write(path.join(source, "package", target.addonFilename), "fixture-native-bytes");
	await Bun.write(path.join(source, "package/DO_NOT_EXTRACT.txt"), "unselected-file");
	await fs.mkdir(destination);
	const archiveFile = path.join(root, "fixture.tgz");
	await $`${nativeTar()} -czf ${archiveFile} -C ${source} package`.quiet();
	const bytes = new Uint8Array(await Bun.file(archiveFile).arrayBuffer());
	const metadata = {
		name: target.packageName,
		version: "18.10.3",
		dist: {
			tarball: "https://registry.npmjs.org/@oh-my-pi/pi-natives-darwin-arm64/-/fixture.tgz",
			integrity: `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`,
		},
	};
	return { root, destination, bytes, metadata, target, close: () => fs.rm(root, { recursive: true, force: true }) };
}

test("native preparation rejects a mismatched archive before replacing an existing addon", async () => {
	const f = await archiveFixture();
	try {
		const target = path.join(f.destination, "packages/natives/native/pi_natives.darwin-arm64.node");
		await Bun.write(target, "existing-addon");
		const corrupt = new Uint8Array(f.bytes);
		corrupt[0] ^= 0xff;
		await expect(installNativeArchive(f.destination, "18.10.3", f.metadata, corrupt, f.target)).rejects.toThrow(
			/完整性|integrity/,
		);
		expect(await Bun.file(target).text()).toBe("existing-addon");
	} finally {
		await f.close();
	}
});

test("native preparation installs only the selected archive member and rejects release-version mismatches", async () => {
	const f = await archiveFixture();
	try {
		await expect(installNativeArchive(f.destination, "18.10.4", f.metadata, f.bytes, f.target)).rejects.toThrow(
			/版本|version/,
		);
		expect(
			await Bun.file(path.join(f.destination, "packages/natives/native/pi_natives.darwin-arm64.node")).exists(),
		).toBe(false);
		await installNativeArchive(f.destination, "18.10.3", f.metadata, f.bytes, f.target);
		expect(
			await Bun.file(path.join(f.destination, "packages/natives/native/pi_natives.darwin-arm64.node")).text(),
		).toBe("fixture-native-bytes");
		expect(await Bun.file(path.join(f.destination, "package/DO_NOT_EXTRACT.txt")).exists()).toBe(false);
		expect(await Bun.file(path.join(f.destination, "packages/natives/native/DO_NOT_EXTRACT.txt")).exists()).toBe(
			false,
		);
	} finally {
		await f.close();
	}
});

test("native preparation refuses an output directory linked outside the selected checkout", async () => {
	const f = await archiveFixture();
	try {
		const outside = path.join(f.root, "outside");
		await fs.mkdir(outside);
		await fs.mkdir(path.join(f.destination, "packages/natives"), { recursive: true });
		await fs.symlink(
			outside,
			path.join(f.destination, "packages/natives/native"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await expect(installNativeArchive(f.destination, "18.10.3", f.metadata, f.bytes, f.target)).rejects.toThrow(
			/范围|checkout/,
		);
		expect(await fs.readdir(outside)).toEqual([]);
	} finally {
		await f.close();
	}
});

test("native preparation checks linked ancestors before creating directories outside the checkout", async () => {
	const f = await archiveFixture();
	try {
		const outside = path.join(f.root, "ancestor-outside");
		await fs.mkdir(outside);
		await fs.symlink(
			outside,
			path.join(f.destination, "packages"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await expect(installNativeArchive(f.destination, "18.10.3", f.metadata, f.bytes, f.target)).rejects.toThrow(
			/范围|checkout/,
		);
		expect(await fs.readdir(outside)).toEqual([]);
	} finally {
		await f.close();
	}
});

test("Windows native preparation selects its own verified addon without extracting unrelated files", async () => {
	const target = nativeTarget("win32", "x64");
	const f = await archiveFixture(target);
	try {
		const installed = await installNativeArchive(f.destination, "18.10.3", f.metadata, f.bytes, target);
		expect(await Bun.file(installed).text()).toBe("fixture-native-bytes");
		expect(await fs.readdir(path.dirname(installed))).toEqual([target.addonFilename]);
		await expect(
			installNativeArchive(f.destination, "18.10.3", f.metadata, f.bytes, nativeTarget("darwin", "arm64")),
		).rejects.toThrow(/名称|版本/);
	} finally {
		await f.close();
	}
});
