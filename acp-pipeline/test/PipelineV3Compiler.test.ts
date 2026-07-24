import * as assert from "node:assert/strict";
import { test } from "node:test";

import { compilePipelineV3Definition } from "../dist/index.js";

const agents = { Codex: {}, Reviewer: {} };

test("compilePipelineV3Definition compiles an immutable DAG with parallel-ready roots", () => {
  const result = compilePipelineV3Definition({
    version: 3,
    id: "demo",
    title: "Demo",
    policies: {
      readonly: { filesystem: "read-only", terminal: "none", network: "disabled", promotion: "discard" },
    },
    nodes: [
      {
        id: "a",
        agent: "Codex",
        prompt: "A",
        policy: "readonly",
        output: { name: "out", type: "note", format: "markdown" },
      },
      {
        id: "b",
        agent: "Reviewer",
        prompt: "B",
        output: { name: "out", type: "note", format: "markdown" },
      },
      {
        id: "join",
        agent: "Codex",
        prompt: "Join",
        needs: ["a", "b"],
        inputs: [
          { name: "a", from: "a.out", type: "note", format: "markdown" },
          { name: "b", from: "b.out", type: "note", format: "markdown" },
        ],
        output: { name: "result", type: "summary", format: "text" },
      },
    ],
  }, agents);

  assert.deepEqual(result.errors, []);
  assert.ok(result.program);
  assert.deepEqual(result.program.rootNodeIds, ["a", "b"]);
  assert.deepEqual(result.program.terminalNodeIds, ["join"]);
  assert.throws(() => ((result.program!.nodes as unknown as unknown[]).push({})));
  assert.equal(typeof (result.program.nodesById as unknown as { set?: unknown }).set, "undefined");
});

test("compilePipelineV3Definition rejects cycles, missing dependencies and unsupported versions deterministically", () => {
  const result = compilePipelineV3Definition({
    version: 2,
    id: "bad",
    title: "Bad",
    nodes: [
      {
        id: "a",
        agent: "Codex",
        prompt: "A",
        needs: ["b", "missing"],
        output: { name: "out", type: "note", format: "markdown" },
      },
      {
        id: "b",
        agent: "Codex",
        prompt: "B",
        needs: ["a"],
        output: { name: "out", type: "note", format: "markdown" },
      },
    ],
  }, agents);

  assert.deepEqual(result.errors, [
    "version must be 3.",
    'node "a" needs unknown node "missing".',
    "cycle detected: a -> b -> a.",
    "pipeline must have at least one root node.",
  ]);
});

test("compilePipelineV3Definition enforces strict typed artifact inputs", () => {
  const result = compilePipelineV3Definition({
    version: 3,
    id: "demo",
    title: "Demo",
    nodes: [
      {
        id: "producer",
        agent: "Codex",
        prompt: "A",
        output: { name: "out", type: "json-spec", format: "json" },
      },
      {
        id: "other",
        agent: "Codex",
        prompt: "B",
        output: { name: "out", type: "note", format: "markdown" },
      },
      {
        id: "consumer",
        agent: "Codex",
        prompt: "C",
        needs: ["other"],
        inputs: [
          { name: "badType", from: "producer.out", type: "note", format: "markdown" },
          { name: "unknown", from: "producer.missing" },
        ],
        output: { name: "out", type: "note", format: "markdown" },
      },
    ],
  }, agents);

  assert.match(result.errors.join("\n"), /outside its dependencies/);
  assert.match(result.errors.join("\n"), /expects type "note"/);
  assert.match(result.errors.join("\n"), /expects format "markdown"/);
  assert.match(result.errors.join("\n"), /unknown artifact "producer.missing"/);
});

test("compilePipelineV3Definition validates agent interview interaction", () => {
  const valid = compilePipelineV3Definition({
    version: 3,
    id: "interview",
    title: "Interview",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents);

  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.program?.nodesById.get("plan")?.interaction, {
    protocol: "proposed-plan",
    repairAttempts: 0,
  });

  const withDefault = compilePipelineV3Definition({
    version: 3,
    id: "interview-default",
    title: "Interview Default",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        interaction: { protocol: "proposed-plan" },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents);
  assert.equal(withDefault.program?.nodesById.get("plan")?.interaction?.repairAttempts, 1);

  const invalid = compilePipelineV3Definition({
    version: 3,
    id: "bad-interview",
    title: "Bad Interview",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        interaction: { protocol: "unknown", repairAttempts: -1 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
      {
        id: "approval",
        type: "pause",
        pause: "approval",
        content: "Approve?",
        interaction: { protocol: "proposed-plan" },
      },
    ],
  }, agents);

  assert.match(invalid.errors.join("\n"), /interaction\.protocol "unknown" is not registered/);
  assert.match(invalid.errors.join("\n"), /interaction\.repairAttempts must be an integer/);
  assert.match(invalid.errors.join("\n"), /interaction is only supported on agent nodes/);
});
