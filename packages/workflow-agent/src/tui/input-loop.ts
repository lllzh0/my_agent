import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import type { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Use OMP's submission path for normal input and hidden goal continuations. */
export async function runProductInputLoop(
	mode: InteractiveMode,
	session: AgentSession,
	closed: Promise<void>,
): Promise<void> {
	const lifetime = new AbortController();
	void closed.then(() => lifetime.abort());
	try {
		while (!lifetime.signal.aborted) {
			const input = await mode.getUserInput(lifetime.signal);
			lifetime.signal.throwIfAborted();
			await submitInteractiveInput(mode, session, input);
		}
	} catch (error) {
		if (!lifetime.signal.aborted) throw error;
	}
}
