// PROTOTYPE JETABLE.
// Question: can Slopify run Codex non-interactively in an sbx clone, create its
// own Git checkpoint, and preview it on the host without changing host files?

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const sandbox = "slopify-prototype-codex";
const marker = ".prototype-sbx-codex-marker.txt";

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return options.capture ? result.stdout.trim() : "";
}

if (existsSync(marker)) {
  console.error(`Refusing to run: ${marker} already exists on the host.`);
  process.exit(1);
}

const hostHead = run("git", ["rev-parse", "HEAD"], { capture: true });
const hostStatus = run("git", ["status", "--porcelain=v1"], { capture: true });
const branch = run("git", ["branch", "--show-current"], { capture: true });

console.log("\n=== Initial state ===");
console.log(JSON.stringify({ sandbox, branch, hostHead, hostStatus }, null, 2));

run("sbx", ["version"]);
run("sbx", ["create", "--clone", "--name", sandbox, "codex", "."]);
run("sbx", [
  "exec",
  sandbox,
  "codex",
  "exec",
  "--dangerously-bypass-approvals-and-sandbox",
  "--ephemeral",
  "--json",
  `Create exactly one file named ${marker} in the repository root containing exactly: docker sandbox codex prototype\\nDo not modify any other file. Do not create a git commit. Then report completion.`,
]);

if (existsSync(marker)) {
  console.error(`Isolation failed: ${marker} appeared on the host.`);
  process.exit(1);
}

run("sbx", ["exec", sandbox, "git", "config", "user.name", "Slopify Prototype"]);
run("sbx", ["exec", sandbox, "git", "config", "user.email", "slopify-prototype@localhost"]);
run("sbx", ["exec", sandbox, "git", "add", "--all"]);
run("sbx", ["exec", sandbox, "git", "commit", "-m", "chore(prototype): create agent checkpoint"]);
const checkpoint = run("sbx", ["exec", sandbox, "git", "rev-parse", "HEAD"], { capture: true });

const remote = `sandbox-${sandbox}`;
run("git", ["fetch", remote]);
run("git", ["diff", "--stat", `${hostHead}..${remote}/${branch}`]);
run("git", ["diff", `${hostHead}..${remote}/${branch}`, "--", marker]);

const finalHostHead = run("git", ["rev-parse", "HEAD"], { capture: true });
const finalHostStatus = run("git", ["status", "--porcelain=v1"], { capture: true });
const hostUnchanged = hostHead === finalHostHead && hostStatus === finalHostStatus && !existsSync(marker);

console.log("\n=== Verdict ===");
console.log(JSON.stringify({ checkpoint, hostUnchanged }, null, 2));
console.log(`\nInspect: sbx exec -it ${sandbox} bash`);
console.log(`Remove:  sbx rm --force ${sandbox}`);

if (!hostUnchanged) process.exit(1);
