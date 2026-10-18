import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/sdk";
import { CLI_THINKING_LEVELS } from "@oh-my-pi/pi-tui/thinking";
import type { RunState } from "../runtime/state";
import { updateProductStatus } from "./permissions";

export async function selectModel(state: RunState, ctx: ExtensionContext, args: string): Promise<void> {
	const models = state.models;
	if (!models) throw new Error("模型连接尚未初始化");
	const [key, effort, ...extra] = args.trim().split(/\s+/);
	if (!key) {
		await ctx.ui.editor(
			"模型连接",
			JSON.stringify(
				{
					current: models.current(),
					pricingStatus: getModelPricingStatus(models.activeModel()),
					choices: models.list(),
					usage: "/model <key> [思考强度]；仅本会话切换，不修改配置。configured 仅表示指定环境变量存在，远端凭据未验证。pricingStatus=unknown 时费用未知，不能把 0 当作免费。",
				},
				null,
				2,
			),
		);
		return;
	}
	const level = effort === undefined ? undefined : CLI_THINKING_LEVELS.find(value => value === effort);
	if (extra.length || (effort !== undefined && level === undefined)) throw new Error("用法：/model <key> [思考强度]");
	ctx.signal?.throwIfAborted();
	await models.select(key, level);
	updateProductStatus(state, ctx);
	ctx.ui.notify(`本会话模型已切换：${models.current().key}；旧会话授权已清除。`, "info");
}
