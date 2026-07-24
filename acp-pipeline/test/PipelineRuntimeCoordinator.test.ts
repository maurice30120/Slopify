import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryPipelineRunStore,
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

function successfulAdapter(
  finalizer: (input: PipelineChangeSetFinalizationInput) => Promise<PipelineChangeSetFinalizationResult>,
  delays: Record<string, number> = {},
  starts: string[] = [],
  completions: string[] = [],
): PipelineRuntimeAdapter & {
  finalizePipelineChangeSet(input: PipelineChangeSetFinalizationInput): Promise<PipelineChangeSetFinalizationResult>;
} {
  return {
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
    finalizePipelineChangeSet: finalizer,
  };
}

function noChangesResult(input: PipelineChangeSetFinalizationInput): PipelineChangeSetFinalizationResult {
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
    const terminalSequence: string[] = [];
    const finalizations: PipelineChangeSetFinalizationInput[] = [];
    const adapter = successfulAdapter(async input => {
      finalizations.push(input);
      terminalSequence.push("finalize");
      return noChangesResult(input);
    }, delays, starts, completions);

    const runtime = new PipelineRuntime(adapter, {
      runIdFactory: () => `run-${delays.a}-${delays.b}`,
      onEvent: event => {
        if (event.type === "completed") terminalSequence.push("completed");
      },
    });
    const result = await runtime.start(program);
    assert.equal(result.status, "completed");
    assert.deepEqual(starts.slice(0, 2).sort(), ["a", "b"]);
    assert.equal(finalizations.length, 1);
    assert.deepEqual(terminalSequence, ["finalize", "completed"]);
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

test("a finalization failure persists and emits failed without a premature completed event", async () => {
  const program = multiAgentProgram();
  const store = new InMemoryPipelineRunStore();
  const terminalEvents: string[] = [];
  const adapter = successfulAdapter(async () => {
    throw new Error("integration conflict");
  });
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-failed-finalization",
    store,
    onEvent: event => {
      if (event.type === "completed" || event.type === "failed") terminalEvents.push(event.type);
    },
  });

  const result = await runtime.start(program);

  assert.equal(result.status, "failed");
  assert.deepEqual(terminalEvents, ["failed"]);
  assert.equal((await store.load("run-failed-finalization"))?.status, "failed");
  assert.deepEqual((await store.readEvents("run-failed-finalization")).map(event => event.type).filter(type => type === "completed" || type === "failed"), ["failed"]);
});

test("a rejected Promotion cancels the run without emitting completed", async () => {
  const program = multiAgentProgram();
  const store = new InMemoryPipelineRunStore();
  const terminalEvents: string[] = [];
  const adapter = successfulAdapter(async input => ({
    ...noChangesResult(input),
    promotion: "rejected",
  }));
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-rejected-promotion",
    store,
    onEvent: event => {
      if (event.type === "completed" || event.type === "cancelled") terminalEvents.push(event.type);
    },
  });

  const result = await runtime.start(program);

  assert.equal(result.status, "cancelled");
  assert.equal((result as typeof result & { promotion?: string }).promotion, "rejected");
  assert.deepEqual(terminalEvents, ["cancelled"]);
  assert.equal((await store.load("run-rejected-promotion"))?.status, "cancelled");
  assert.deepEqual(
    (await store.readEvents("run-rejected-promotion"))
      .map(event => event.type)
      .filter(type => type === "completed" || type === "cancelled"),
    ["cancelled"],
  );
});

test("a cancelled Promotion cancels the run without emitting completed", async () => {
  const program = multiAgentProgram();
  const store = new InMemoryPipelineRunStore();
  const terminalEvents: string[] = [];
  const adapter = successfulAdapter(async input => ({
    ...noChangesResult(input),
    promotion: "cancelled",
  }));
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-cancelled-promotion",
    store,
    onEvent: event => {
      if (event.type === "completed" || event.type === "cancelled") terminalEvents.push(event.type);
    },
  });

  const result = await runtime.start(program);

  assert.equal(result.status, "cancelled");
  assert.equal((result as typeof result & { promotion?: string }).promotion, "cancelled");
  assert.deepEqual(terminalEvents, ["cancelled"]);
  assert.equal((await store.load("run-cancelled-promotion"))?.status, "cancelled");
  assert.deepEqual(
    (await store.readEvents("run-cancelled-promotion"))
      .map(event => event.type)
      .filter(type => type === "completed" || type === "cancelled"),
    ["cancelled"],
  );
});
