import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type {
	CreateSandboxOptions,
	Sandbox,
	SandboxRunOptions,
} from "@ai-hero/sandcastle";
import { buildSandboxMounts } from "../src/SandboxMounts.js";

import { parseBridgeConfig } from "../src/BridgeConfig.js";
import { defaultSandcastleRuntime } from "../src/DefaultSandcastleRuntime.js";
import { enrichProviderRunError } from "../src/ProviderRunError.js";
import { decidePromotionPolicy } from "../src/PromotionPolicy.js";
import {
	SandcastleBridgeAgent,
	type SandcastleRuntime,
} from "../src/BridgeAgent.js";

test("parseBridgeConfig parses provider model effort and image", () => {
	const config = parseBridgeConfig(
		["--provider", "pi", "--model", "glm-5.2", "--effort", "high"],
		{ ACP_SANDCASTLE_IMAGE: "custom:image", FOO: "bar" },
	);

	assert.deepEqual(config, {
		provider: "pi",
		model: "glm-5.2",
		effort: "high",
		maxIterations: 5,
		imageName: "custom:image",
		env: {
			ACP_SANDCASTLE_IMAGE: "custom:image",
			FOO: "bar",
		},
	});
	assert.throws(
		() => parseBridgeConfig(["--provider", "other", "--model", "gpt-5"], {}),
		/provider/,
	);
	assert.equal(
		parseBridgeConfig(["--provider", "codex", "--model", "gpt-5"], {}).maxIterations,
		1,
	);
	assert.equal(
		parseBridgeConfig(["--provider", "vibe", "--model", "mistral-large-latest"], {}).maxIterations,
		5,
	);
	assert.equal(
		parseBridgeConfig(["--provider", "pi", "--model", "glm-5.2", "--max-iterations", "7"], {}).maxIterations,
		7,
	);
	assert.throws(
		() => parseBridgeConfig(["--provider", "pi", "--model", "glm-5.2", "--max-iterations", "1.5"], {}),
		/max-iterations/,
	);
});

test("defaultSandcastleRuntime creates Pi and Vibe providers", () => {
	const piProvider = defaultSandcastleRuntime.createProvider({
		provider: "pi",
		model: "opencode-go/kimi-k2.6",
		effort: "high",
		maxIterations: 5,
		imageName: "fake",
		env: { FOO: "bar" },
	});
	assert.equal(piProvider.name, "pi");
	assert.equal(piProvider.env.FOO, "bar");
	assert.match(
		piProvider.buildPrintCommand({ prompt: "hello", dangerouslySkipPermissions: true }).command,
		/pi -p --mode json --model 'opencode-go\/kimi-k2\.6' --thinking high/,
	);

	const vibeProvider = defaultSandcastleRuntime.createProvider({
		provider: "vibe",
		model: "mistral-large-latest",
		maxIterations: 1,
		imageName: "fake",
		env: { FOO: "bar" },
	});
	assert.equal(vibeProvider.name, "vibe");
	assert.equal(vibeProvider.env.VIBE_ACTIVE_MODEL, "mistral-large-latest");
	assert.equal(vibeProvider.env.FOO, "bar");
	assert.equal(vibeProvider.env.VIBE_HOME, "/home/agent/.vibe");
	assert.deepEqual(vibeProvider.buildPrintCommand({
		prompt: "hello",
		dangerouslySkipPermissions: true,
	}), {
		command: "vibe --prompt 'hello' --output streaming --trust",
	});
	assert.deepEqual(vibeProvider.buildPrintCommand({
		prompt: "don't lose quotes",
		dangerouslySkipPermissions: true,
	}), {
		command: "vibe --prompt 'don'\\''t lose quotes' --output streaming --trust",
	});
	assert.deepEqual(vibeProvider.parseStreamLine(JSON.stringify({
		role: "assistant",
		content: "done",
	})), [
		{ type: "text", text: "done" },
		{ type: "result", result: "done" },
	]);
	assert.deepEqual(vibeProvider.parseStreamLine(JSON.stringify({
		role: "assistant",
		content: "",
		reasoning_content: "I'll inspect the pipeline UI.",
	})), [
		{ type: "text", text: "I'll inspect the pipeline UI." },
	]);
});

test("decidePromotionPolicy maps no changes and promotion modes", () => {
	const changed = {
		diff: "diff",
		filesChanged: 1,
		branch: "sandcastle/test",
		baseRef: "HEAD",
		worktreePath: "/tmp/worktree",
	};
	const empty = { ...changed, diff: "", filesChanged: 0 };

	assert.equal(decidePromotionPolicy(empty, "ask"), "discard_no_changes");
	assert.equal(decidePromotionPolicy(changed, "autoApply"), "auto_apply");
	assert.equal(decidePromotionPolicy(changed, "autoReject"), "auto_reject");
	assert.equal(decidePromotionPolicy(changed, "ask"), "prompt");
});

test("enrichProviderRunError surfaces Pi Go usage limit as a UI-ready message", () => {
	const error = enrichProviderRunError(
		new Error([
			"pi exited with code 1:",
			"Error: 429 GoUsageLimitError: usage limit reached for opencode-go/kimi-k2.6",
		].join("\n")),
		{ provider: "pi", cwd: process.cwd() },
	);

	assert.equal(
		error.message,
		"Pi Sandcastle failed before writing: provider returned 429 GoUsageLimitError for opencode-go/kimi-k2.6, so no write tool was executed.",
	);
});

test("buildSandboxMounts adds git overrides for docker worktrees", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandcastle-mounts-"));
	try {
		git(repo, ["init"]);
		const cwd = path.join(repo, "plugin-pi");
		fs.mkdirSync(cwd);
		const branch = "sandcastle/acp/vibe/123";
		const mounts = buildSandboxMounts({
			provider: "vibe",
			model: "test",
			imageName: "fake",
		}, cwd, branch);

		const parentGitMount = mounts.find(mount =>
			mount.sandboxPath === "/.sandcastle-parent-git"
		);
		assert.ok(parentGitMount);
		assert.equal(fs.statSync(parentGitMount.hostPath).isDirectory(), true);

		const gitOverride = mounts.find(mount =>
			mount.sandboxPath === "/home/agent/workspace/.git"
		);
		assert.ok(gitOverride);
		assert.equal(gitOverride.readonly, true);
		assert.equal(
			fs.readFileSync(gitOverride.hostPath, "utf8"),
			"gitdir: /.sandcastle-parent-git/worktrees/sandcastle-acp-vibe-123\n",
		);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("buildSandboxMounts mounts Vibe home for vibe provider", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandcastle-vibe-home-"));
	try {
		const mounts = buildSandboxMounts({
			provider: "vibe",
			model: "test",
			imageName: "fake",
		}, repo);

		const vibeHome = mounts.find(mount => mount.sandboxPath === "/home/agent/.vibe");
		assert.ok(vibeHome);
		assert.equal(vibeHome.readonly, false);
		assert.equal(vibeHome.hostPath, path.join(repo, ".sandcastle", "vibe-home"));
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("SandcastleBridgeAgent previews applies and rejects through an isolated worktree", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandcastle-agent-"));
	try {
		git(repo, ["init"]);
		git(repo, ["config", "user.email", "tests@example.com"]);
		git(repo, ["config", "user.name", "ACP Tests"]);
		fs.writeFileSync(path.join(repo, "README.md"), "# Test\n", "utf8");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "initial"]);

		const connection = new FakeConnection();
		const runtime = new FakeRuntime();
		const agent = new SandcastleBridgeAgent(connection as unknown as AgentSideConnection, {
			provider: "codex",
			model: "test",
			imageName: "fake",
			maxIterations: 1,
		}, runtime);
		const { sessionId } = await agent.newSession({ cwd: repo, mcpServers: [] });

		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "make a change" }],
		});

		assert.equal(result.stopReason, "end_turn");
		assert.equal(runtime.lastMaxIterations, 1);
		assert.equal(fs.existsSync(path.join(repo, "sentinel.txt")), false);
		assert.ok(connection.updates.some(update => update.update.content?.text === "done"));
		const preview = await agent.extMethod("sandcastle/preview", { sessionId });
		assert.equal(preview.filesChanged, 1);
		const applied = await agent.extMethod("sandcastle/apply", { sessionId });
		assert.equal(applied.success, true);
		assert.equal(fs.readFileSync(path.join(repo, "sentinel.txt"), "utf8"), "make a change");
		await agent.dispose();
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

class FakeConnection {
	readonly updates: any[] = [];

	async sessionUpdate(update: any): Promise<void> {
		this.updates.push(update);
	}
}

class FakeRuntime implements SandcastleRuntime {
	lastMaxIterations: number | undefined;

	createProvider(): any {
		return {
			name: "fake",
			env: {},
			captureSessions: false,
			buildPrintCommand: () => ({ command: "true" }),
			parseStreamLine: () => [],
		};
	}

	createSandboxProvider(): any {
		return {};
	}

	async createSandbox(options: CreateSandboxOptions): Promise<Sandbox> {
		const repo = options.cwd!;
		const worktree = path.join(repo, ".sandcastle-test", options.branch.replaceAll("/", "-"));
		fs.mkdirSync(path.dirname(worktree), { recursive: true });
		git(repo, ["worktree", "add", "-b", options.branch, worktree, options.baseBranch || "HEAD"]);

		return {
			branch: options.branch,
			worktreePath: worktree,
			run: async (runOptions: SandboxRunOptions) => {
				const prompt = runOptions.prompt || "";
				this.lastMaxIterations = runOptions.maxIterations;
				fs.writeFileSync(path.join(worktree, "sentinel.txt"), prompt, "utf8");
				(runOptions.logging as { onAgentStreamEvent?: (event: {
					type: "text";
					message: string;
					iteration: number;
					timestamp: Date;
				}) => void } | undefined)?.onAgentStreamEvent?.({
					type: "text",
					message: "done",
					iteration: 1,
					timestamp: new Date(),
				});
				return {
					iterations: [],
					stdout: "done",
					commits: [],
				};
			},
			interactive: async () => ({ commits: [], exitCode: 0 }),
			close: async () => {
				git(repo, ["worktree", "remove", "--force", worktree]);
				git(repo, ["branch", "-D", options.branch]);
				return {};
			},
			[Symbol.asyncDispose]: async () => undefined,
		};
	}
}
