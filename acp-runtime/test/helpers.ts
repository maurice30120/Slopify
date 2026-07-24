import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert/strict";

export function createTempWorkspace(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "acp-pi-extension-"));
}

export function writeFile(
	workspace: string,
	relativePath: string,
	content: string,
): void {
	const filePath = path.join(workspace, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

export function writeDefaultConfig(workspace: string): void {
	writeFile(
		workspace,
		".acp/acp-agents.json",
		JSON.stringify(
			{
				agents: {
					"Codex CLI": {
						command: "codex",
						args: [],
						env: {},
					},
					"Pi Agent": {
						command: "pi-acp",
						args: [],
						env: {},
					},
				},
				pipeline: {
					enabled: true,
					instructionsMaxBytes: 262144,
				},
			},
			null,
			2,
		),
	);
}

export function writeDemoPipeline(workspace: string): void {
	writeFile(
		workspace,
		".acp/pipelines/demo.yaml",
		[
			"version: 2",
			"id: demo",
			"title: Demo Pipeline",
			"primitives:",
			"  planner:",
			"    agent: Codex CLI",
			"    prompt: |",
			"      Plan this request:",
			"      {{userPrompt}}",
			"    output: proposed_plan",
			"    sideEffects: none",
			"    permissions: allowAll",
			"  implementer:",
			"    agent: Pi Agent",
			"    prompt: |",
			"      Implement:",
			"      {{steps.approval.output}}",
			"    output: markdown",
			"    sideEffects: workspace",
			"    permissions: ask",
			"steps:",
			"  - id: planner",
			"    use: planner",
			"  - id: approval",
			"    type: approval",
			'    input: "{{steps.planner.output}}"',
			"  - id: implementer",
			"    use: implementer",
			"",
		].join("\n"),
	);
}

export function writePlanExecuteVerifyPipeline(workspace: string): void {
	writeFile(
		workspace,
		".acp/pipelines/plan-execute-verify.yaml",
		[
			"version: 3",
			"id: plan-execute-verify",
			"title: Plan Execute Verify",
			"nodes:",
			"  - id: plan",
			"    agent: Pi Agent",
			"    prompt: |",
			"      Plan this request:",
			"      {{userPrompt}}",
			"    output:",
			"      name: plan",
			"      type: acp.proposed-plan/v1",
			"      format: markdown",
			"  - id: approval",
			"    type: pause",
			"    pause: approval",
			"    needs: [plan]",
			'    content: "{{inputs.plan}}"',
			"    format: proposed-plan",
			"    inputs:",
			"      - name: plan",
			"        from: plan.plan",
			"        type: acp.proposed-plan/v1",
			"        format: markdown",
			"    output:",
			"      name: approved",
			"      type: acp.approval/v1",
			"      format: markdown",
			"  - id: implement",
			"    agent: Vibe Sandcastle",
			"    needs: [approval]",
			"    inputs:",
			"      - name: plan",
			"        from: approval.approved",
			"        type: acp.approval/v1",
			"        format: markdown",
			"    policy:",
			"      filesystem: workspace-write",
			"      terminal: workspace-write",
			"      promotion: ask",
			"    prompt: |",
			"      Implement:",
			"      {{inputs.plan}}",
			"    output:",
			"      name: changes",
			"      type: acp.changes/v1",
			"      format: markdown",
			"  - id: verify",
			"    agent: Vibe",
			"    needs: [implement]",
			"    inputs:",
			"      - name: changes",
			"        from: implement.changes",
			"        type: acp.changes/v1",
			"        format: markdown",
			"    prompt: |",
			"      Verify:",
			"      {{inputs.changes}}",
			"    output:",
			"      name: report",
			"      type: acp.review/v1",
			"      format: markdown",
			"",
		].join("\n"),
	);
}

export function writeDemoTeam(workspace: string): void {
	writeFile(workspace, ".acp/teams/planner.md", "Plan carefully.");
	writeFile(
		workspace,
		".acp/teams/implementer.md",
		"Implement the approved plan.",
	);
	writeFile(workspace, ".acp/teams/reviewer.md", "Review the implementation.");
	writeFile(
		workspace,
		".acp/teams/feature-team.yaml",
		[
			"version: 1",
			"id: feature",
			"title: Feature Team",
			"roles:",
			"  planner:",
			"    agent: Codex CLI",
			"    instructions: planner.md",
			"  implementer:",
			"    agent: Pi Agent",
			"    instructions: implementer.md",
			"  reviewer:",
			"    agent: Codex CLI",
			"    instructions: reviewer.md",
			"",
		].join("\n"),
	);
}

export function writeSkill(
	workspace: string,
	name: string,
	frontmatter: Record<string, string>,
	body = `# ${name}`,
): void {
	const lines = ["---"];
	for (const [key, value] of Object.entries(frontmatter)) {
		lines.push(`${key}: ${value}`);
	}
	lines.push("---", "", body, "");
	writeFile(workspace, `.agents/skills/${name}/SKILL.md`, lines.join("\n"));
}

export function writePipelineFile(
	workspace: string,
	fileName: string,
	lines: string[],
): void {
	writeFile(workspace, `.acp/pipelines/${fileName}`, lines.join("\n"));
}

export function assertIncludes(
	haystack: string,
	needle: string,
	message?: string,
): void {
	assert.ok(
		haystack.includes(needle),
		message ?? `Expected output to include ${needle}`,
	);
}
