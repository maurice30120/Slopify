import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { AgentProcessManager } from "../src/acp/agentProcess.js";
import { SessionAuthHandler } from "../src/acp/authHandler.js";
import { ConnectionManager } from "../src/acp/connectionManager.js";
import { defaultAcpConnector } from "../src/acp/defaultConnector.js";
import { FileSystemHandler } from "../src/acp/fileSystemHandler.js";
import {
	AgentProcessDiedError,
	PipelineTimeoutError,
} from "../src/acp/operationGuards.js";
import { PermissionHandler } from "../src/acp/permissionHandler.js";
import { AcpClient } from "../src/acp/acpClient.js";
import { filterEnv, validatePath } from "../src/acp/security.js";
import { SessionUpdateHandler } from "../src/acp/sessionUpdateHandler.js";
import { TerminalHandler } from "../src/acp/terminalHandler.js";
import { createTempWorkspace, writeFile } from "./helpers.js";

test("validatePath allows workspace files and rejects parent traversal", () => {
	const workspace = createTempWorkspace();
	writeFile(workspace, "safe/file.txt", "ok");

	const resolved = validatePath("safe/file.txt", workspace);

	assert.equal(
		resolved,
		fs.realpathSync(path.join(workspace, "safe/file.txt")),
	);
	assert.throws(
		() => validatePath("../outside.txt", workspace),
		/escapes workspace boundary/,
	);
});

test("validatePath rejects symlinks that escape the workspace", () => {
	const workspace = createTempWorkspace();
	const outside = createTempWorkspace();
	writeFile(outside, "secret.txt", "secret");
	fs.symlinkSync(outside, path.join(workspace, "outside-link"));

	assert.throws(
		() => validatePath("outside-link/secret.txt", workspace),
		/escapes workspace boundary/,
	);
});

test("filterEnv strips denied variables case-insensitively", () => {
	assert.deepEqual(
		filterEnv({
			PATH: "/tmp/bin",
			node_options: "--require ./hook",
			SAFE_TOKEN: "ok",
			DyLd_LiBrArY_pAtH: "/tmp/lib",
		}),
		{ SAFE_TOKEN: "ok" },
	);
});

test("FileSystemHandler reads line slices and writes inside the workspace", async () => {
	const workspace = createTempWorkspace();
	const handler = new FileSystemHandler(workspace);
	writeFile(workspace, "notes.txt", "one\ntwo\nthree\nfour");

	const slice = await handler.readTextFile({
		path: "notes.txt",
		line: 2,
		limit: 2,
	} as any);
	await handler.writeTextFile({
		path: "nested/out.txt",
		content: "written",
	} as any);

	assert.equal(slice.content, "two\nthree");
	assert.equal(
		fs.readFileSync(path.join(workspace, "nested/out.txt"), "utf8"),
		"written",
	);
});

test("FileSystemHandler rejects paths outside the workspace", async () => {
	const handler = new FileSystemHandler(createTempWorkspace());

	await assert.rejects(
		() => handler.readTextFile({ path: "../secret.txt" } as any),
		/escapes workspace boundary/,
	);
	await assert.rejects(
		() => handler.writeTextFile({ path: "../secret.txt", content: "" } as any),
		/escapes workspace boundary/,
	);
});

test("PermissionHandler cancels when UI is unavailable", async () => {
	const handler = new PermissionHandler(() => undefined);

	const result = await handler.requestPermission(permissionParams());

	assert.deepEqual(result, { outcome: { outcome: "cancelled" } });
});

test("PermissionHandler can auto-approve sandbox bridge permissions", async () => {
	const handler = new PermissionHandler(() => undefined, { autoApproveAll: true });

	const result = await handler.requestPermission(permissionParams());

	assert.deepEqual(result, {
		outcome: { outcome: "selected", optionId: "allow" },
	});
});

test("PermissionHandler returns the option selected by Pi UI", async () => {
	let title = "";
	let labels: string[] = [];
	const handler = new PermissionHandler(
		() =>
			({
				hasUI: true,
				ui: {
					select: async (requestedTitle: string, requestedLabels: string[]) => {
						title = requestedTitle;
						labels = requestedLabels;
						return requestedLabels[1];
					},
				},
			}) as any,
	);

	const result = await handler.requestPermission(permissionParams());

	assert.equal(title, "Edit file");
	assert.deepEqual(labels, ["Allow [allow_once]", "Reject [reject_once]"]);
	assert.deepEqual(result, {
		outcome: { outcome: "selected", optionId: "reject" },
	});
});

test("PermissionHandler cancels when Pi UI selection is empty", async () => {
	const handler = new PermissionHandler(
		() =>
			({
				hasUI: true,
				ui: {
					select: async () => undefined,
				},
			}) as any,
	);

	const result = await handler.requestPermission(permissionParams());

	assert.deepEqual(result, { outcome: { outcome: "cancelled" } });
});

test("PermissionHandler cancels when Pi UI selection times out", async () => {
	let resolveSelect!: (value: string | undefined) => void;
	const handler = new PermissionHandler(
		() =>
			({
				hasUI: true,
				ui: {
					select: async () =>
						new Promise<string | undefined>(resolve => {
							resolveSelect = resolve;
						}),
				},
			}) as any,
		{ timeoutMs: 5 },
	);

	const result = await handler.requestPermission(permissionParams());

	resolveSelect(undefined);
	assert.deepEqual(result, { outcome: { outcome: "cancelled" } });
});

test("SessionAuthHandler identifies ACP auth-required errors", () => {
	const handler = new SessionAuthHandler(
		() => {},
		() => undefined,
	);

	assert.equal(handler.isAuthRequiredError({ code: -32000 }), true);
	assert.equal(handler.isAuthRequiredError(new Error("auth required")), true);
	assert.equal(handler.isAuthRequiredError(new Error("other")), false);
});

test("SessionAuthHandler kills the agent when auth is unavailable", async () => {
	const killed: string[] = [];
	const handler = new SessionAuthHandler(
		(agentId) => {
			killed.push(agentId);
		},
		() => undefined,
	);

	await assert.rejects(
		() =>
			handler.runAuthFlow("Codex", "agent-1", {
				initResponse: { authMethods: [] },
			} as any),
		/did not advertise any auth methods/,
	);
	assert.deepEqual(killed, ["agent-1"]);
});

test("SessionAuthHandler confirms a single auth method before authenticating", async () => {
	const authenticated: string[] = [];
	const handler = new SessionAuthHandler(
		() => {},
		() =>
			({
				hasUI: true,
				ui: {
					confirm: async () => true,
				},
			}) as any,
	);

	await handler.runAuthFlow("Codex", "agent-1", {
		initResponse: {
			authMethods: [{ id: "browser", name: "Browser" }],
		},
		connection: {
			authenticate: async ({ methodId }: { methodId: string }) => {
				authenticated.push(methodId);
			},
		},
	} as any);

	assert.deepEqual(authenticated, ["browser"]);
});

test("SessionAuthHandler selects among multiple auth methods", async () => {
	const authenticated: string[] = [];
	const handler = new SessionAuthHandler(
		() => {},
		() =>
			({
				hasUI: true,
				ui: {
					select: async (_title: string, labels: string[]) => labels[1],
				},
			}) as any,
	);

	await handler.runAuthFlow("Codex", "agent-1", {
		initResponse: {
			authMethods: [
				{ id: "device", name: "Device" },
				{ id: "browser", name: "Browser" },
			],
		},
		connection: {
			authenticate: async ({ methodId }: { methodId: string }) => {
				authenticated.push(methodId);
			},
		},
	} as any);

	assert.deepEqual(authenticated, ["browser"]);
});

test("SessionAuthHandler times out an auth UI decision and kills the agent", async () => {
	const killed: string[] = [];
	let resolveConfirm!: (value: boolean) => void;
	const handler = new SessionAuthHandler(
		(agentId) => {
			killed.push(agentId);
		},
		() =>
			({
				hasUI: true,
				ui: {
					confirm: async () =>
						new Promise<boolean>(resolve => {
							resolveConfirm = resolve;
						}),
				},
			}) as any,
		{ timeouts: { authUiMs: 5 } },
	);

	await assert.rejects(
		() =>
			handler.runAuthFlow("Codex", "agent-1", {
				initResponse: {
					authMethods: [{ id: "browser", name: "Browser" }],
				},
			} as any),
		PipelineTimeoutError,
	);
	resolveConfirm(false);
	assert.deepEqual(killed, ["agent-1"]);
});

test("SessionAuthHandler times out authenticate and kills the agent", async () => {
	const killed: string[] = [];
	let resolveAuthenticate!: (value: unknown) => void;
	const handler = new SessionAuthHandler(
		(agentId) => {
			killed.push(agentId);
		},
		() =>
			({
				hasUI: true,
				ui: {
					confirm: async () => true,
				},
			}) as any,
		{ timeouts: { authenticateMs: 5 } },
	);

	await assert.rejects(
		() =>
			handler.runAuthFlow("Codex", "agent-1", {
				initResponse: {
					authMethods: [{ id: "browser", name: "Browser" }],
				},
				connection: {
					authenticate: async () =>
						new Promise(resolve => {
							resolveAuthenticate = resolve;
						}),
				},
			} as any),
		PipelineTimeoutError,
	);
	resolveAuthenticate({});
	assert.deepEqual(killed, ["agent-1"]);
});

test("SessionUpdateHandler forwards updates only to current listeners", () => {
	const handler = new SessionUpdateHandler();
	const seen: string[] = [];
	const first = (update: { sessionId: string }) =>
		seen.push(`first:${update.sessionId}`);
	const second = (update: { sessionId: string }) =>
		seen.push(`second:${update.sessionId}`);

	handler.addListener(first as any);
	handler.addListener(second as any);
	handler.handleUpdate({ sessionId: "s1", update: {} } as any);
	handler.removeListener(first as any);
	handler.handleUpdate({ sessionId: "s2", update: {} } as any);
	handler.dispose();
	handler.handleUpdate({ sessionId: "s3", update: {} } as any);

	assert.deepEqual(seen, ["first:s1", "second:s1", "second:s2"]);
});

test("AcpClient delegates ACP client methods to handlers", async () => {
	const calls: string[] = [];
	const client = new AcpClient(
		{
			readTextFile: async () => {
				calls.push("read");
				return { content: "content" };
			},
			writeTextFile: async () => {
				calls.push("write");
				return {};
			},
		} as any,
		{
			createTerminal: async () => {
				calls.push("createTerminal");
				return { terminalId: "term-1" };
			},
			terminalOutput: async () => {
				calls.push("terminalOutput");
				return { output: "", truncated: false };
			},
			waitForTerminalExit: async () => {
				calls.push("waitForTerminalExit");
				return { exitCode: 0, signal: null };
			},
			killTerminal: async () => {
				calls.push("killTerminal");
				return {};
			},
			releaseTerminal: async () => {
				calls.push("releaseTerminal");
				return {};
			},
			dispose: () => {
				calls.push("disposeTerminal");
			},
		} as any,
		{
			requestPermission: async () => {
				calls.push("permission");
				return { outcome: { outcome: "cancelled" } };
			},
		} as any,
		{
			handleUpdate: () => {
				calls.push("sessionUpdate");
			},
		} as any,
	);

	await client.readTextFile({ path: "file.txt" } as any);
	await client.writeTextFile({ path: "file.txt", content: "" } as any);
	await client.requestPermission(permissionParams());
	await client.sessionUpdate({ sessionId: "s1", update: {} } as any);
	await client.createTerminal({ command: "echo" } as any);
	await client.terminalOutput({ terminalId: "term-1" } as any);
	await client.waitForTerminalExit({ terminalId: "term-1" } as any);
	await client.killTerminal({ terminalId: "term-1" } as any);
	await client.releaseTerminal({ terminalId: "term-1" } as any);
	client.dispose();

	assert.deepEqual(calls, [
		"read",
		"write",
		"permission",
		"sessionUpdate",
		"createTerminal",
		"terminalOutput",
		"waitForTerminalExit",
		"killTerminal",
		"releaseTerminal",
		"disposeTerminal",
	]);
});

test("ConnectionManager throws when process stdio is missing", async () => {
	const manager = new ConnectionManager(new SessionUpdateHandler(), {
		getPermissionContext: () => undefined,
	});

	await assert.rejects(
		() => manager.connect("agent-1", {} as any, createTempWorkspace()),
		/missing stdio streams/,
	);
});

test("ConnectionManager rejects initialize when the agent process exits", async () => {
	const manager = new ConnectionManager(new SessionUpdateHandler(), {
		getPermissionContext: () => undefined,
		timeouts: { initializeMs: 10_000 },
	});
	const processExit = Promise.resolve({
		agentId: "agent-1",
		code: 1,
		signal: null,
	});

	await assert.rejects(
		() =>
			manager.connect(
				"agent-1",
				{
					stdout: new PassThrough(),
					stdin: new PassThrough(),
				} as any,
				createTempWorkspace(),
				processExit,
			),
		AgentProcessDiedError,
	);
});

test("ConnectionManager times out initialize when the agent is silent", async () => {
	const manager = new ConnectionManager(new SessionUpdateHandler(), {
		getPermissionContext: () => undefined,
		timeouts: { initializeMs: 5 },
	});
	const stdout = new PassThrough();
	const stdin = new PassThrough();

	try {
		await assert.rejects(
			() =>
				manager.connect(
					"agent-1",
					{
						stdout,
						stdin,
					} as any,
					createTempWorkspace(),
				),
			PipelineTimeoutError,
		);
	} finally {
		stdout.destroy();
		stdin.destroy();
	}
});

test("ConnectionManager removeConnection and dispose clear tracked clients", () => {
	const manager = new ConnectionManager(new SessionUpdateHandler(), {
		getPermissionContext: () => undefined,
	});
	const disposed: string[] = [];

	(manager as any).connections.set("agent-1", {
		client: { dispose: () => disposed.push("agent-1") },
	});
	(manager as any).connections.set("agent-2", {
		client: { dispose: () => disposed.push("agent-2") },
	});

	manager.removeConnection("agent-1");
	manager.dispose();

	assert.deepEqual(disposed, ["agent-2"]);
	assert.equal((manager as any).connections.size, 0);
});

test("defaultAcpConnector kills a spawned agent when connection fails", async () => {
	const originalSpawn = AgentProcessManager.prototype.spawnAgent;
	const originalKill = AgentProcessManager.prototype.killAgent;
	const originalConnect = ConnectionManager.prototype.connect;
	const originalDispose = ConnectionManager.prototype.dispose;
	const killed: string[] = [];
	let disposed = false;

	AgentProcessManager.prototype.spawnAgent = (name, config) => ({
		id: "agent-1",
		name,
		process: {} as any,
		config,
	});
	AgentProcessManager.prototype.killAgent = (agentId: string) => {
		killed.push(agentId);
		return true;
	};
	ConnectionManager.prototype.connect = async () => {
		throw new Error("connect failed");
	};
	ConnectionManager.prototype.dispose = () => {
		disposed = true;
	};

	try {
		await assert.rejects(
			() =>
				defaultAcpConnector({
					agentName: "Codex",
					processConfig: { command: "codex" },
					workspaceCwd: createTempWorkspace(),
					sessionUpdateHandler: new SessionUpdateHandler(),
					getPermissionContext: () => undefined,
				}),
			/connect failed/,
		);
		assert.deepEqual(killed, ["agent-1"]);
		assert.equal(disposed, true);
	} finally {
		AgentProcessManager.prototype.spawnAgent = originalSpawn;
		AgentProcessManager.prototype.killAgent = originalKill;
		ConnectionManager.prototype.connect = originalConnect;
		ConnectionManager.prototype.dispose = originalDispose;
	}
});

test("TerminalHandler captures output and exit status", async () => {
	const handler = new TerminalHandler(createTempWorkspace());

	try {
		const terminal = await handler.createTerminal({
			command: process.execPath,
			args: ["--print", "12345"],
			env: [{ name: "FORCE_COLOR", value: "0" }],
		} as any);
		const exit = await handler.waitForTerminalExit({
			terminalId: terminal.terminalId,
		} as any);
		const output = await handler.terminalOutput({
			terminalId: terminal.terminalId,
		} as any);

		assert.equal(exit.exitCode, 0);
		assert.equal(output.output, "12345\n");
		assert.equal(output.truncated, false);
		assert.deepEqual(output.exitStatus, { exitCode: 0, signal: null });
	} finally {
		handler.dispose();
	}
});

test("TerminalHandler truncates output to the requested byte limit", async () => {
	const handler = new TerminalHandler(createTempWorkspace());

	try {
		const terminal = await handler.createTerminal({
			command: process.execPath,
			args: ["--print", "1234567890"],
			outputByteLimit: 5,
			env: [{ name: "FORCE_COLOR", value: "0" }],
		} as any);
		await handler.waitForTerminalExit({
			terminalId: terminal.terminalId,
		} as any);
		const output = await handler.terminalOutput({
			terminalId: terminal.terminalId,
		} as any);

		assert.equal(output.output, "7890\n");
		assert.equal(output.truncated, true);
	} finally {
		handler.dispose();
	}
});

test("TerminalHandler release removes the terminal", async () => {
	const handler = new TerminalHandler(createTempWorkspace());

	try {
		const terminal = await handler.createTerminal({
			command: process.execPath,
			args: ["-e", "setTimeout(() => {}, 1000)"],
		} as any);
		await handler.releaseTerminal({ terminalId: terminal.terminalId } as any);

		await assert.rejects(
			() => handler.terminalOutput({ terminalId: terminal.terminalId } as any),
			/Terminal not found/,
		);
	} finally {
		handler.dispose();
	}
});

function permissionParams() {
	return {
		sessionId: "session-1",
		toolCall: {
			toolCallId: "tool-1",
			title: "Edit file",
			kind: "edit",
		},
		options: [
			{ optionId: "allow", name: "Allow", kind: "allow_once" },
			{ optionId: "reject", name: "Reject", kind: "reject_once" },
		],
	} as any;
}
