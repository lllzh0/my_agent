/** Shared argument grammar keeps option values out of the launcher's subcommand routing. */
export const CLI_OPTIONS = {
	help: { type: "boolean", short: "h" },
	demo: { type: "boolean" },
	light: { type: "boolean" },
	print: { type: "boolean", short: "p" },
	defaults: { type: "boolean" },
	home: { type: "string" },
	cwd: { type: "string" },
	prompt: { type: "string" },
	resume: { type: "string" },
	output: { type: "string" },
	permissions: { type: "string" },
	ui: { type: "string" },
	preset: { type: "string" },
} as const;
