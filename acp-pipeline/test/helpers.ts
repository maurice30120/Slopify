import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function createTempWorkspace(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "acp-pipeline-test-"));
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

export function minimalAgentConfigs(): Record<string, unknown> {
	return {
		Codex: {},
		Vibe: {},
	};
}
