import { TextJudge, chatTextBackend, judgeQuestions } from "@oh-my-pi/pi-ai/judgment";
import type { Api, ApiKey, Model } from "@oh-my-pi/pi-ai";
import questions from "../prompts/judge/permission-review.json" with { type: "json" };
import type { Policy, Reviewer } from "./policy";
import { redact } from "../storage";

const reviewQuestions = judgeQuestions(questions);
const reasons = {
	destructive: "自动审核发现可能删除数据、覆盖工作或改写历史，请核对具体目标",
	sensitive: "自动审核发现可能涉及凭据或私有资料，请核对访问和传送范围",
	external: "自动审核发现发布、部署或其他外部副作用，请确认本次操作",
	security: "自动审核发现可能改变权限、启动行为或安全设置，请确认本次操作",
	uncertain: "自动审核无法可靠判断操作影响，请人工核对本次请求",
};

/** A separate bounded model request, with no workflow resources or action tools. */
export function createReviewer(
	model: Model<Api>,
	apiKey: ApiKey | undefined,
	sessionId: string,
	policy: Policy,
): Reviewer {
	const backend = chatTextBackend(model, {
		apiKey,
		sessionId: `${sessionId}:review`,
		onAttempt(message) {
			policy.reviewUsage.requests++;
			policy.reviewUsage.tokens += message.usage.totalTokens;
			policy.reviewUsage.cost += message.usage.cost.total;
		},
	});
	const judge = new TextJudge({
		...backend,
		parseRetries: 0,
		async complete(prompt, options) {
			const response = await backend.complete(prompt, options);
			if (!Object.hasOwn(questions.review.criteria, response.text.trim()))
				throw new Error("自动审核必须返回完整且唯一的已知标签");
			return response;
		},
	});
	return async (action, signal) => {
		if (!policy.userTask.trim())
			return { decision: "ask", risk: "unknown", reason: "缺少用户任务上下文，请人工核对操作" };
		const state = JSON.stringify(
			redact({
				humanTask: policy.userTask,
				action,
				workspace: policy.workspace,
				limits: policy.settings,
				sandboxEnabled: true,
			}),
		);
		if (Buffer.byteLength(state) > 32_000)
			return { decision: "ask", risk: "unknown", reason: "操作超过自动审核的上下文上限，请人工核对完整请求" };
		const response = await judge.judge({ state, questions: reviewQuestions }, { signal });
		const choice = response.answers.review.choice;
		return choice === "allow"
			? { decision: "allow", risk: "low", reason: "独立审核认为操作符合任务且影响范围有限" }
			: { decision: "ask", risk: choice === "uncertain" ? "unknown" : "high", reason: reasons[choice] };
	};
}
