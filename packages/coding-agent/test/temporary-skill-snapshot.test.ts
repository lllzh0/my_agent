import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSkillPromptMessage, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";

test("approved skill snapshots render their original body after the source changes or disappears", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-snapshot-"));
	const filePath = path.join(directory, "SKILL.md");
	const content =
		"---\nname: reviewer\ndescription: Approved review\n---\nOriginal instructions.\n<!-- Keep this comment. -->\n";
	const skill: Skill & { content: string } = {
		name: "reviewer",
		description: "Approved review",
		filePath,
		baseDir: directory,
		source: "test",
		content,
	};
	try {
		await Bun.write(filePath, content);
		const input = { args: "  focus on authorization  ", prompt: "$reviewer focus on authorization" };
		const original = await buildSkillPromptMessage(skill, input);
		await Bun.write(filePath, "---\nname: reviewer\ndescription: Changed\n---\nUNAPPROVED BODY\n");
		const changed = await buildSkillPromptMessage(skill, input);
		expect(changed).toEqual(original);
		expect(changed.message).toContain("Original instructions.\n<!-- Keep this comment. -->");
		expect(changed.message).not.toContain("description: Approved review");
		expect(changed.details).toMatchObject({ args: "focus on authorization", prompt: input.prompt, lineCount: 2 });
		await fs.rm(filePath);
		expect(await buildSkillPromptMessage(skill, input)).toEqual(original);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
