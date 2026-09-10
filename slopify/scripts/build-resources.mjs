import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const cliRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.dirname(cliRoot);
const destination = path.join(cliRoot, 'dist/resources');
const manifest = JSON.parse(fs.readFileSync(path.join(cliRoot, 'resources.manifest.json'), 'utf8'));
const temporary = `${destination}.tmp`;

function copy(relative) {
  const target = path.join(temporary, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(repoRoot, relative), target, { recursive: true, dereference: true, errorOnExist: true });
}

try {
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  for (const [name, entry] of Object.entries(manifest.skills)) {
    for (const dependency of entry.dependencies) {
      if (!manifest.skills[dependency]) throw new Error(`Undeclared dependency ${dependency} of ${name}`);
    }
    const relative = `.agents/skills/${name}`;
    const content = fs.readFileSync(path.join(repoRoot, relative, 'SKILL.md'), 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    const metadata = header && yaml.load(header[1]);
    if (!metadata || metadata.name !== name || !metadata.description) throw new Error(`Invalid skill ${name}`);
    for (const file of entry.requiredFiles ?? []) {
      if (!fs.statSync(path.join(repoRoot, relative, file)).isFile()) throw new Error(`Missing resource ${file} of ${name}`);
    }
    copy(relative);
  }
  for (const name of manifest.instructions) copy(`.acp/agents/${name}`);
  for (const name of manifest.sandboxKits ?? []) copy(`.sbx/${name}`);
  for (const name of manifest.pipelines) {
    const relative = `.acp/pipelines/${name}`;
    const pipeline = yaml.load(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
    for (const node of pipeline.nodes) {
      node.skills = (node.skills ?? []).map(skill => {
        if (!manifest.skills[skill]) throw new Error(`Undeclared skill ${skill} in ${name}`);
        return `slopify:${skill}`;
      });
      const instructions = node.instructionsFile ?? node.promptFile;
      if (instructions && !fs.existsSync(path.resolve(temporary, '.acp/pipelines', instructions))) {
        throw new Error(`Undeclared instructions ${instructions} in ${name}`);
      }
    }
    const target = path.join(temporary, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, yaml.dump(pipeline, { lineWidth: -1 }));
  }
  // Ship deliberate defaults, never the developer's local agent environment or credentials.
  fs.copyFileSync(path.join(cliRoot, manifest.agentConfig), path.join(temporary, '.acp/acp-agents.json'));
  fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(temporary, destination);
} catch (error) {
  fs.rmSync(temporary, { recursive: true, force: true });
  throw error;
}
