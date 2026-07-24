import type { AgentProcessExit } from "./agentProcess.js";

export class PipelineTimeoutError extends Error {
	constructor(
		readonly phase: string,
		readonly timeoutMs: number,
	) {
		super(`ACP operation "${phase}" timed out after ${timeoutMs}ms.`);
		this.name = "PipelineTimeoutError";
	}
}

export class AgentProcessDiedError extends Error {
	constructor(
		readonly phase: string,
		readonly exit: AgentProcessExit,
	) {
		super(formatProcessExit(phase, exit));
		this.name = "AgentProcessDiedError";
	}
}

export interface AcpOperationTimeouts {
	initializeMs: number;
	newSessionMs: number;
	authenticateMs: number;
	promptMs: number;
	permissionMs: number;
	authUiMs: number;
	promotionUiMs: number;
}

export type PartialAcpOperationTimeouts = Partial<AcpOperationTimeouts>;

export const DEFAULT_ACP_OPERATION_TIMEOUTS: AcpOperationTimeouts = {
	initializeMs: 30_000,
	newSessionMs: 30_000,
	authenticateMs: 120_000,
	promptMs: 600_000,
	permissionMs: 300_000,
	authUiMs: 600_000,
	promotionUiMs: 600_000,
};

export function resolveTimeouts(
	overrides: PartialAcpOperationTimeouts | undefined,
): AcpOperationTimeouts {
	return {
		...DEFAULT_ACP_OPERATION_TIMEOUTS,
		...(overrides ?? {}),
	};
}

export async function withTimeout<T>(
	phase: string,
	timeoutMs: number,
	promise: Promise<T>,
	onTimeout?: () => void | Promise<void>,
): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return promise;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new PipelineTimeoutError(phase, timeoutMs));
			void Promise.resolve(onTimeout?.()).catch(() => undefined);
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

export async function withProcessGuard<T>(
	phase: string,
	processExit: Promise<AgentProcessExit> | undefined,
	promise: Promise<T>,
): Promise<T> {
	if (!processExit) {
		return promise;
	}

	return Promise.race([
		promise,
		processExit.then(exit => {
			throw new AgentProcessDiedError(phase, exit);
		}),
	]);
}

function formatProcessExit(phase: string, exit: AgentProcessExit): string {
	if (exit.error) {
		return `ACP agent process failed during "${phase}": ${exit.error.message}`;
	}
	return `ACP agent process exited during "${phase}" (code=${exit.code}, signal=${exit.signal}).`;
}
