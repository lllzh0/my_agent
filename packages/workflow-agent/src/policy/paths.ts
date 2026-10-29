import * as path from "node:path";

/** Pure containment check shared with the early launcher; no policy/SDK initialization. */
export function contained(root: string, target: string): boolean {
	const child = path.relative(root, target);
	return (
		!path.isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
	);
}
