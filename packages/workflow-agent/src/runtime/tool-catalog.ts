/** Product capabilities only. Keep native/extension discovery outside this allowlist. */
export const PRODUCT_TOOL_NAMES = [
	"read",
	"write",
	"edit",
	"ls",
	"grep",
	"find",
	"bash",
	"job_output",
	"job_stop",
	"web_search",
	"web_fetch",
	"read_document",
	"read_source",
	"search_source",
	"write_report",
	"mcp_list",
	"mcp_call",
	"import_mcp_source",
	"task_list",
	"task_update",
	"ask_user",
	"goal",
] as const;

export const BARE_TOOL_NAMES = PRODUCT_TOOL_NAMES.filter(
	name => !["mcp_list", "mcp_call", "import_mcp_source"].includes(name),
);
