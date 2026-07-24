import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  PipelineRuntime,
  compilePipelineV3Definition,
  orderPipelineNodeIdsForIntegration,
  type PipelineChangeSetFinalizationInput,
  type PipelineChangeSetFinalizationResult,
  type PipelineNodeExecutionResult,
  type PipelineRuntimeAdapter,
} from "../dist/index.js";

const agents = { Codex: {} };

function multiAgentProgram() {
  return compilePipelineV3Definition({
    version: 3,
    id: "deterministic-checkpoints",
    title: "Deterministic checkpoints",
    nodes: [
      {
        id: "a",
        agent: "Codex",
        prompt: "A",
        policy: { filesystem: "workspace-write", terminal: "workspace-write", promotion: "ask" },
        output: { name: "out", type: "note", format: "text" },
      },
      {
        id: "c",
        agent: "Codex",
        prompt: "C",
        needs: ["a"],
        policy: { filesystem: "workspace-write", terminal: "workspace-write", promotion: "ask" },
        output: { name: "out", type: "note", format: "text" },
      },
      {
        id: "b",
        agent: "Codex",
        prompt: "B",
        policy: { filesystem: "workspace-write", terminal: "workspace-write", promotion: "ask" },
        output: { name: "out", type: "note", format: "text" },
      },
      {
        id: "join",
        agent: "Codex",
        prompt: "Join",
        needs: ["b", "c"],
        output: { name: "out", type: "note", format: "text" },
      },
    ],
  }, agents).program!;
}

test("orders checkpoints by DAG level and declaration order, not declaration alone", () => {
  const program = multiAgentProgram();
  assert.deepEqual(
    orderPipelineNodeIdsForIntegration(program, ["c", "b", "a"]),
    ["a", "b", "c"],
  );
});

test("parallel agents may finish in opposite orders while finalization stays unique", async () => {
  const program = multiAgentProgram();

  const run = async (delays: Record<string, number>) => {
    const starts: string[] = [];
    const completions: string[] = [];
    const finalizations: PipelineChangeSetFinalizationInput[] = [];
    const adapter: PipelineRuntimeAdapter & {
      finalizePipelineChangeSet(input: PipelineChangeSetFinalizationInput): Promise<PipelineChangeSetFinalizationResult>;
    } = {
      async createSession({ runId, node }) {
        return {
          runId,
          nodeId: node.id,
          async send(): Promise<PipelineNodeExecutionResult> {
            starts.push(node.id);
            await new Promise(resolve => setTimeout(resolve, delays[node.id] ?? 0));
            completions.push(node.id);
            return {
              artifact: {
                name: "out",
                type: "note",
                format: "text",
                value: node.id,
              },
            };
          },
          async cancel() {},
          async close() {},
        };
      },
      async finalizePipelineChangeSet(input) {
        finalizations.push(input);
        return {
          promotion: "no_changes",
          preview: {
            baseCommit: "base",
            changeSetCommit: "base",
            fileCount: 0,
            files: [],
            diff: "",
          },
          integratedNodeIds: orderPipelineNodeIdsForIntegration(input.program, ["c", "b", "a"]),
        };
      },
    };

    const runtime = new PipelineRuntime(adapter, { runIdFactory: () => `run-${delays.a}-${delays.b}` });
    const result = await runtime.start(program);
    assert.equal(result.status, "completed");
    assert.deepEqual(starts.slice(0, 2).sort(), ["a", "b"]);
    assert.equal(finalizations.length, 1);
    return {
      completions: completions.filter(nodeId => nodeId !== "join"),
      integrated: (result as typeof result & { changeSet?: PipelineChangeSetFinalizationResult }).changeSet?.integratedNodeIds,
    };
  };

  const first = await run({ a: 5, b: 40, c: 5, join: 0 });
  const second = await run({ a: 40, b: 5, c: 5, join: 0 });

  assert.notDeepEqual(first.completions, second.completions);
  assert.deepEqual(first.integrated, ["a", "b", "c"]);
  assert.deepEqual(second.integrated, first.integrated);
});
