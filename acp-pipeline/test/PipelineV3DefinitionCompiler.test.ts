import * as assert from "node:assert/strict";
import { test } from "node:test";

import { compilePipelineV3Definition } from "../dist/index.js";

test("compilePipelineV3Definition accepts instructionsFile as the public role-file field", () => {
  const result = compilePipelineV3Definition({
    version: 3,
    id: "structured-prompt",
    title: "Structured Prompt",
    nodes: [{
      id: "plan",
      agent: "Codex",
      instructionsFile: "../agents/planner.md",
      prompt: "Plan {{userPrompt}}",
      output: { name: "plan", type: "acp.plan/v1", format: "markdown" },
    }],
  }, { Codex: {} });

  assert.deepEqual(result.errors, []);
  assert.equal(result.program?.nodes[0].prompt, "Plan {{userPrompt}}");
  assert.equal(result.program?.nodes[0].promptFile, "../agents/planner.md");
});

test("compilePipelineV3Definition rejects node network policy for Docker Sandbox Runs", () => {
  const definition = {
    version: 3,
    id: "sandbox-network",
    title: "Sandbox Network",
    policies: {
      connected: { network: "enabled" },
    },
    nodes: [{
      id: "implement",
      agent: "Isolated",
      prompt: "Implement",
      policy: "connected",
      output: { name: "result", type: "text", format: "text" },
    }],
  };

  const sandbox = compilePipelineV3Definition(definition, {
    Isolated: { transport: "sandbox", agent: "codex", model: "gpt" },
  });
  assert.deepEqual(sandbox.errors, [
    'node "implement" network policy is not supported for Docker Sandbox Runs; configure the global policy with "sbx policy".',
  ]);

  const native = compilePipelineV3Definition(definition, {
    Isolated: { command: "codex", args: ["acp"] },
  });
  assert.deepEqual(native.errors, []);
});

test("compilePipelineV3Definition compiles typed workspace handoff metadata", () => {
  const result = compilePipelineV3Definition({
    version: 3,
    id: "delivery",
    title: "Delivery",
    nodes: [{
      id: "approval",
      type: "pause",
      pause: "approval",
      content: "{{inputs.files}}",
      handoff: {
        kind: "workspace-files",
        minimumReferences: 2,
        layout: "delivery",
      },
      workspaceGuard: "documentation-only",
      output: { name: "approved", type: "acp.sequential-delivery/v1", format: "markdown" },
    }],
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.program?.nodes[0].handoff, {
    kind: "workspace-files",
    minimumReferences: 2,
    layout: "delivery",
  });
  assert.equal(result.program?.nodes[0].workspaceGuard, "documentation-only");
});

test("compilePipelineV3Definition rejects invalid workspace handoff metadata", () => {
  const result = compilePipelineV3Definition({
    version: 3,
    id: "delivery",
    title: "Delivery",
    nodes: [{
      id: "approval",
      type: "pause",
      pause: "approval",
      content: "Approve",
      handoff: { kind: "workspace-files", minimumReferences: 0, layout: "unknown" },
    }],
  });

  assert.deepEqual(result.errors, [
    'node "approval" handoff.minimumReferences must be an integer greater than or equal to 1.',
    'node "approval" handoff.layout must be "delivery" when provided.',
  ]);
});
