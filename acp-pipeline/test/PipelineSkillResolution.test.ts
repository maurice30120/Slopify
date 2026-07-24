import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  discoverModelInvokedSkills,
  renderExplicitPipelineSkills,
  renderModelSkillCatalog,
  resolveExplicitPipelineSkills,
  type PipelineSkillEntry,
} from "../dist/index.js";

const workspace = "/repo";
const entries: PipelineSkillEntry[] = [
  {
    name: "implement",
    description: "Implement work",
    filePath: "/repo/.agents/skills/implement/SKILL.md",
    content: "---\nname: implement\n---\nImplement.",
  },
  {
    name: "grill-me",
    description: "Ask questions",
    filePath: "/repo/.agents/skills/grill-me/SKILL.md",
    content: "---\nname: grill-me\n---\nAsk.",
    disableModelInvocation: true,
  },
  {
    name: "to-spec",
    description: "Spec",
    filePath: "C:\\repo\\.agents\\skills\\to-spec\\SKILL.md",
    content: "Spec.",
  },
];

test("discoverModelInvokedSkills excludes explicit-only skills deterministically", () => {
  assert.deepEqual(
    discoverModelInvokedSkills(entries, workspace).map(skill => skill.name),
    ["implement", "to-spec"],
  );

  const catalog = renderModelSkillCatalog(discoverModelInvokedSkills(entries, workspace));
  assert.match(catalog, /implement/);
  assert.match(catalog, /to-spec/);
  assert.doesNotMatch(catalog, /grill-me/);
});

test("resolveExplicitPipelineSkills injects disable-model-invocation skills", () => {
  const result = resolveExplicitPipelineSkills(["grill-me", "implement"], entries, workspace);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skills.map(skill => skill.name), ["grill-me", "implement"]);
  assert.match(renderExplicitPipelineSkills(result.skills), /<skill name="grill-me">/);
});

test("resolveExplicitPipelineSkills reports missing and disabled skills before execution", () => {
  const result = resolveExplicitPipelineSkills(
    ["grill-me", "to-tickets", "implement"],
    entries,
    workspace,
    ["implement"],
  );

  assert.deepEqual(result.skills.map(skill => skill.name), ["implement"]);
  assert.deepEqual(result.errors, [
    'Pipeline node skill "grill-me" is disabled for this agent.',
    'Pipeline node references missing skill "to-tickets".',
  ]);
});

test("resolveExplicitPipelineSkills supports folder aliases and stable path rendering", () => {
  const result = resolveExplicitPipelineSkills(["/to-spec"], entries, workspace);

  assert.deepEqual(result.errors, []);
  assert.equal(result.skills[0].name, "to-spec");
  assert.equal(result.skills[0].relativePath, "C:/repo/.agents/skills/to-spec/SKILL.md");
});

test("resolveExplicitPipelineSkills reports ambiguous aliases", () => {
  const result = resolveExplicitPipelineSkills(["review"], [
    {
      name: "review",
      description: "First",
      filePath: "/repo/.agents/skills/review/SKILL.md",
    },
    {
      name: "review",
      description: "Second",
      filePath: "/repo/.agents/skills/other/SKILL.md",
    },
  ], workspace);

  assert.deepEqual(result.skills, []);
  assert.match(result.errors[0], /ambiguous/);
  assert.match(result.errors[0], /review\/SKILL\.md/);
  assert.match(result.errors[0], /other\/SKILL\.md/);
});

test("resolveExplicitPipelineSkills covers named delivery pipeline skills", () => {
  const names = ["grill-me", "to-spec", "to-tickets", "implement", "tdd", "code-review"];
  const result = resolveExplicitPipelineSkills(
    names,
    names.map(name => ({
      name,
      description: `${name} description`,
      filePath: `/repo/.agents/skills/${name}/SKILL.md`,
      content: `${name} body`,
      disableModelInvocation: name === "grill-me" || name === "implement" || name === "code-review",
    })),
    workspace,
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skills.map(skill => skill.name), [
    "code-review",
    "grill-me",
    "implement",
    "tdd",
    "to-spec",
    "to-tickets",
  ]);
  const rendered = renderExplicitPipelineSkills(result.skills);
  for (const name of names) {
    assert.match(rendered, new RegExp(`<skill name="${name}">`));
  }
});
