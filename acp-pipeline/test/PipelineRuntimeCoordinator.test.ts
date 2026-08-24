import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryPipelineRunStore,
  PipelineIntegrationConflictError,
  PipelineSandboxResumeDivergenceError,
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
        retry: { maxAttempts: 1 },
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

test("a multi-parent descendant receives every satisfied dependency checkpoint in stable declaration order", async () => {
  const program = multiAgentProgram();
  const received: Array<{ nodeId: string; dependencies: string[] }> = [];
  const adapter: PipelineRuntimeAdapter = {
    async createSession({ runId, node }) {
      return {
        runId,
        nodeId: node.id,
        async send(input): Promise<PipelineNodeExecutionResult> {
          received.push({
            nodeId: node.id,
            dependencies: (input.dependencyCheckpoints ?? []).map(checkpoint => `${checkpoint.nodeId}#${checkpoint.attempt}`),
          });
          await input.onSandboxRunState?.({
            sandboxName: `sandbox-${node.id}`,
            runId,
            nodeId: node.id,
            attempt: input.attempt ?? 1,
            baseCommit: "base",
            integrationState: "checkpointed",
            resourceState: "removed",
            checkpoint: {
              status: "checkpointed",
              commit: `commit-${node.id}`,
              remote: `sandbox-${node.id}`,
              ref: `refs/checkpoints/${node.id}`,
              preview: { baseCommit: "base", checkpointCommit: `commit-${node.id}`, fileCount: 1, files: [`${node.id}.ts`], diff: "diff" },
            },
          });
          return { artifact: { name: "out", type: "note", format: "text", value: node.id } };
        },
        async cancel() {},
        async close() {},
      };
    },
  };

  const completed = await new PipelineRuntime(adapter, {
    runIdFactory: () => "run-dependency-composition",
  }).start(program, { maxConcurrency: 2 });

  assert.equal(completed.status, "completed");
  assert.deepEqual(received.find(entry => entry.nodeId === "join")?.dependencies, ["c#1", "b#1"]);
});

test("an incompatible descendant composition suspends inspectably and resumes only that descendant", async () => {
  const program = multiAgentProgram();
  const attempts: string[] = [];
  let conflict = true;
  const runtime = new PipelineRuntime({
    async createSession({ runId, node }) {
      return {
        runId, nodeId: node.id,
        async send(input): Promise<PipelineNodeExecutionResult> {
          attempts.push(`${node.id}#${input.attempt}`);
          if (node.id === "join" && conflict) {
            conflict = false;
            throw new PipelineIntegrationConflictError({
              runId, retryNodeId: "join",
              checkpoints: [
                { nodeId: "b", attempt: 1, commit: "commit-b", ref: "refs/checkpoints/b" },
                { nodeId: "c", attempt: 1, commit: "commit-c", ref: "refs/checkpoints/c" },
              ],
              files: ["src/shared.ts"],
            });
          }
          return { artifact: { name: "out", type: "note", format: "text", value: node.id } };
        },
        async cancel() {}, async close() {},
      };
    },
  }, { runIdFactory: () => "run-descendant-conflict", store: new InMemoryPipelineRunStore() });

  const paused = await runtime.start(program, { maxConcurrency: 2 });
  assert.equal(paused.status, "paused");
  assert.equal(paused.snapshot.pendingPause?.integrationConflict?.retryNodeId, "join");
  assert.match(paused.status === "paused" ? paused.pause.content : "", /src\/shared\.ts/);

  const completed = await runtime.resume(paused.runId, {
    pauseId: paused.status === "paused" ? paused.pause.id : "unreachable",
    kind: "approve",
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(attempts.filter(value => value.startsWith("join#")), ["join#1", "join#1"]);
  assert.deepEqual(attempts.filter(value => !value.startsWith("join#")).sort(), ["a#1", "b#1", "c#1"]);
});

test("persists sandbox identity, base, checkpoint, integration state, and diagnostics before finalization", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "durable-sandbox-run",
    title: "Durable sandbox run",
    nodes: [{
      id: "work",
      agent: "Codex",
      prompt: "Work",
      policy: { filesystem: "workspace-write", terminal: "workspace-write", promotion: "discard" },
      output: { name: "out", type: "note", format: "text" },
    }],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  let finalizationSnapshot: unknown;
  const adapter: PipelineRuntimeAdapter & {
    finalizePipelineChangeSet(input: PipelineChangeSetFinalizationInput): Promise<PipelineChangeSetFinalizationResult>;
  } = {
    async createSession({ runId, node }) {
      return {
        runId,
        nodeId: node.id,
        async send(input): Promise<PipelineNodeExecutionResult> {
          await input.onSandboxRunState?.({
            sandboxName: "slopify-run-work-1-deadbeef",
            sandboxId: "sandbox-id-42",
            runId,
            nodeId: node.id,
            attempt: input.attempt ?? 1,
            baseCommit: "base123",
            integrationState: "sandbox_created",
            resourceState: "active",
            diagnosticsPath: "/repo/.acp/logs/sandboxes/slopify-run-work-1-deadbeef.json",
          });
          await input.onSandboxRunState?.({
            sandboxName: "slopify-run-work-1-deadbeef",
            sandboxId: "sandbox-id-42",
            runId,
            nodeId: node.id,
            attempt: input.attempt ?? 1,
            baseCommit: "base123",
            integrationState: "checkpointed",
            resourceState: "removed",
            diagnosticsPath: "/repo/.acp/logs/sandboxes/slopify-run-work-1-deadbeef.json",
            checkpoint: {
              status: "checkpointed",
              commit: "checkpoint456",
              remote: "sandbox-slopify-run-work-1-deadbeef",
              ref: "refs/slopify/checkpoints/slopify-run-work-1-deadbeef",
              preview: {
                baseCommit: "base123",
                checkpointCommit: "checkpoint456",
                fileCount: 1,
                files: ["src/work.ts"],
                diff: "diff",
              },
            },
          });
          return { artifact: { name: "out", type: "note", format: "text", value: "done" } };
        },
        async cancel() {},
        async close() {},
      };
    },
    async finalizePipelineChangeSet(input) {
      finalizationSnapshot = input.snapshot;
      return {
        promotion: "no_changes",
        preview: { baseCommit: "base123", changeSetCommit: "base123", fileCount: 0, files: [], diff: "" },
        integratedNodeIds: ["work"],
      };
    },
  };
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-durable-sandbox",
    store,
  });

  const completed = await runtime.start(program);

  assert.equal(completed.status, "completed");
  const sandboxRun = completed.snapshot.sandboxRuns?.["slopify-run-work-1-deadbeef"];
  assert.equal(sandboxRun?.sandboxId, "sandbox-id-42");
  assert.equal(sandboxRun?.baseCommit, "base123");
  assert.equal(sandboxRun?.checkpoint?.commit, "checkpoint456");
  assert.equal(sandboxRun?.integrationState, "integrated");
  assert.match(sandboxRun?.diagnosticsPath ?? "", /slopify-run-work-1-deadbeef\.json$/);
  assert.equal(
    (finalizationSnapshot as { sandboxRuns?: Record<string, { integrationState: string }> })
      .sandboxRuns?.["slopify-run-work-1-deadbeef"]?.integrationState,
    "integrating",
  );
});

test("recovers a running node from its persisted Sandbox Run after process reconstruction", async () => {
  const program = compilePipelineV3Definition({
    version: 3, id: "recover-created", title: "Recover created",
    nodes: [{ id: "work", agent: "Codex", prompt: "Work", output: { name: "out", type: "note", format: "text" } }],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  await store.create({
    runId: "run-recover-created",
    pipelineId: program.id,
    status: "running",
    nodeStates: { work: { status: "running", attempts: 1 } },
    artifacts: {},
    diagnostics: [],
    sandboxRuns: {
      "sandbox-work": {
        sandboxName: "sandbox-work", sandboxId: "stable-id", runId: "run-recover-created", nodeId: "work", attempt: 1,
        baseCommit: "base", integrationState: "sandbox_created", resourceState: "active",
      },
    },
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:01.000Z",
  });
  const resumedStates: string[] = [];
  const adapter = successfulAdapter(async () => ({
    promotion: "no_changes",
    preview: { baseCommit: "base", changeSetCommit: "base", fileCount: 0, files: [], diff: "" },
    integratedNodeIds: ["work"],
  }));
  const originalCreateSession = adapter.createSession;
  adapter.createSession = async input => {
    const session = await originalCreateSession(input);
    const originalSend = session.send.bind(session);
    session.send = async turn => {
      resumedStates.push(turn.resumeSandboxRun?.integrationState ?? "missing");
      return originalSend(turn);
    };
    return session;
  };
  const runtime = new PipelineRuntime(adapter, { programs: [program], store });

  const completed = await runtime.recover("run-recover-created");

  assert.equal(completed.status, "completed");
  assert.deepEqual(resumedStates, ["sandbox_created"]);
  assert.equal(completed.snapshot.nodeStates.work.attempts, 1);
});

test("approving a node-recovery divergence retries the unfinished node instead of finalizing it", async () => {
  const program = compilePipelineV3Definition({
    version: 3, id: "recover-node-divergence", title: "Recover node divergence",
    nodes: [{ id: "work", agent: "Codex", prompt: "Work", output: { name: "out", type: "note", format: "text" } }],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  await store.create({
    runId: "run-node-divergence", pipelineId: program.id, status: "running",
    nodeStates: { work: { status: "running", attempts: 1 } }, artifacts: {}, diagnostics: [],
    sandboxRuns: {
      "sandbox-work": {
        sandboxName: "sandbox-work", sandboxId: "stable-id", runId: "run-node-divergence", nodeId: "work", attempt: 1,
        baseCommit: "base", integrationState: "sandbox_created", resourceState: "active",
      },
    },
    createdAt: "2026-07-24T10:00:00.000Z", updatedAt: "2026-07-24T10:00:01.000Z",
  });
  let sends = 0;
  let finalizations = 0;
  const adapter: PipelineRuntimeAdapter & {
    finalizePipelineChangeSet(input: PipelineChangeSetFinalizationInput): Promise<PipelineChangeSetFinalizationResult>;
  } = {
    async createSession({ runId, node }) {
      return {
        runId, nodeId: node.id,
        async send(input) {
          sends += 1;
          if (sends <= 2) {
            throw new PipelineSandboxResumeDivergenceError({
              runId, sandboxName: "sandbox-work", nodeId: node.id, attempt: input.attempt ?? 1,
              diagnostic: "Sandbox identity divergence: observed foreign, expected stable.",
            });
          }
          return { artifact: { name: "out", type: "note", format: "text", value: "recovered" } };
        },
        async cancel() {}, async close() {},
      };
    },
    async finalizePipelineChangeSet() {
      finalizations += 1;
      return {
        promotion: "no_changes",
        preview: { baseCommit: "base", changeSetCommit: "base", fileCount: 0, files: [], diff: "" },
        integratedNodeIds: ["work"],
      };
    },
  };
  const runtime = new PipelineRuntime(adapter, { programs: [program], store });
  const paused = await runtime.recover("run-node-divergence");

  assert.equal(paused.status, "paused");
  assert.equal(paused.snapshot.nodeStates.work.status, "running");
  assert.equal(finalizations, 0);

  const pausedAgain = await runtime.resume(paused.runId, {
    pauseId: paused.status === "paused" ? paused.pause.id : "unreachable", kind: "approve",
  });

  assert.equal(pausedAgain.status, "paused");
  assert.equal(pausedAgain.snapshot.nodeStates.work.status, "running");
  assert.equal(finalizations, 0);

  const completed = await runtime.resume(pausedAgain.runId, {
    pauseId: pausedAgain.status === "paused" ? pausedAgain.pause.id : "unreachable", kind: "approve",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.snapshot.nodeStates.work.status, "completed");
  assert.equal(sends, 3);
  assert.equal(finalizations, 1);
});

test("a recovery divergence cancels and drains parallel node sessions before pausing", async () => {
  const program = compilePipelineV3Definition({
    version: 3, id: "recover-parallel-divergence", title: "Recover parallel divergence",
    nodes: [
      { id: "work", agent: "Codex", prompt: "Work", output: { name: "out", type: "note", format: "text" } },
      { id: "peer", agent: "Codex", prompt: "Peer", output: { name: "out", type: "note", format: "text" } },
    ],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  await store.create({
    runId: "run-parallel-divergence", pipelineId: program.id, status: "running",
    nodeStates: { work: { status: "running", attempts: 1 }, peer: { status: "running", attempts: 1 } },
    artifacts: {}, diagnostics: [],
    sandboxRuns: {
      "sandbox-work": {
        sandboxName: "sandbox-work", runId: "run-parallel-divergence", nodeId: "work", attempt: 1,
        baseCommit: "base", integrationState: "sandbox_created", resourceState: "active",
      },
    },
    createdAt: "2026-07-24T10:00:00.000Z", updatedAt: "2026-07-24T10:00:01.000Z",
  });
  let releasePeer: (() => void) | undefined;
  let peerCancelled = 0;
  const adapter: PipelineRuntimeAdapter = {
    async createSession({ runId, node }) {
      return {
        runId, nodeId: node.id,
        async send(input) {
          if (node.id === "work") {
            throw new PipelineSandboxResumeDivergenceError({
              runId, sandboxName: "sandbox-work", nodeId: node.id, attempt: input.attempt ?? 1,
              diagnostic: "Sandbox identity divergence.",
            });
          }
          await new Promise<void>(resolve => { releasePeer = resolve; });
          return { artifact: { name: "out", type: "note", format: "text", value: "peer" } };
        },
        async cancel() {
          if (node.id === "peer") peerCancelled += 1;
          releasePeer?.();
        },
        async close() {},
      };
    },
  };
  const runtime = new PipelineRuntime(adapter, { programs: [program], store });

  const paused = await runtime.recover("run-parallel-divergence");

  assert.equal(paused.status, "paused");
  assert.equal(peerCancelled, 1);
  assert.equal(paused.snapshot.nodeStates.peer.status, "running");
  assert.equal(paused.snapshot.artifacts["peer.out"], undefined);
});

test("read-only sandbox checkpoints remain checkpointed instead of being recorded as integrated", async () => {
  const program = compilePipelineV3Definition({
    version: 3, id: "read-only-state", title: "Read-only state",
    nodes: [{ id: "inspect", agent: "Codex", prompt: "Inspect", output: { name: "out", type: "note", format: "text" } }],
  }, agents).program!;
  const adapter: PipelineRuntimeAdapter & {
    finalizePipelineChangeSet(input: PipelineChangeSetFinalizationInput): Promise<PipelineChangeSetFinalizationResult>;
  } = {
    async createSession({ runId, node }) {
      return {
        runId, nodeId: node.id,
        async send(input) {
          await input.onSandboxRunState?.({
            sandboxName: "sandbox-inspect", runId, nodeId: node.id, attempt: 1,
            baseCommit: "base", integrationState: "checkpointed", resourceState: "removed",
            checkpoint: {
              status: "checkpointed", commit: "checkpoint", remote: "sandbox-inspect", ref: "refs/checkpoints/inspect",
              preview: { baseCommit: "base", checkpointCommit: "checkpoint", fileCount: 1, files: ["ignored.ts"], diff: "diff" },
            },
          });
          return { artifact: { name: "out", type: "note", format: "text", value: "inspected" } };
        },
        async cancel() {}, async close() {},
      };
    },
    async finalizePipelineChangeSet() {
      return {
        promotion: "no_changes",
        preview: { baseCommit: "", changeSetCommit: "", fileCount: 0, files: [], diff: "" },
        integratedNodeIds: [],
      };
    },
  };
  const runtime = new PipelineRuntime(adapter, { runIdFactory: () => "run-read-only-state" });

  const completed = await runtime.start(program);

  assert.equal(completed.status, "completed");
  assert.equal(completed.snapshot.sandboxRuns?.["sandbox-inspect"]?.integrationState, "checkpointed");
});

test("recovers a crash after checkpoint persistence and before Promotion without relaunching the agent", async () => {
  const program = compilePipelineV3Definition({
    version: 3, id: "recover-before-promotion", title: "Recover before Promotion",
    nodes: [{
      id: "work", agent: "Codex", prompt: "Work",
      policy: { filesystem: "workspace-write", terminal: "workspace-write", promotion: "discard" },
      output: { name: "out", type: "note", format: "text" },
    }],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  await store.create({
    runId: "run-recover-before-promotion",
    pipelineId: program.id,
    status: "running",
    nodeStates: { work: { status: "completed", attempts: 1 } },
    artifacts: {
      "work.out": { name: "out", type: "note", format: "text", value: "done", producerNodeId: "work" },
    },
    diagnostics: [],
    sandboxRuns: {
      "sandbox-work": {
        sandboxName: "sandbox-work", sandboxId: "stable-id", runId: "run-recover-before-promotion", nodeId: "work", attempt: 1,
        baseCommit: "base", integrationState: "checkpointed", resourceState: "removed", output: "done",
        checkpoint: {
          status: "checkpointed", commit: "checkpoint", remote: "sandbox-sandbox-work", ref: "refs/checkpoints/work",
          preview: { baseCommit: "base", checkpointCommit: "checkpoint", fileCount: 1, files: ["work.ts"], diff: "diff" },
        },
      },
    },
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:01.000Z",
  });
  let sessions = 0;
  let finalizations = 0;
  const adapter: PipelineRuntimeAdapter & {
    finalizePipelineChangeSet(input: PipelineChangeSetFinalizationInput): Promise<PipelineChangeSetFinalizationResult>;
  } = {
    async createSession() {
      sessions += 1;
      throw new Error("The recovered completed node must not be relaunched.");
    },
    async finalizePipelineChangeSet() {
      finalizations += 1;
      return {
        promotion: "no_changes",
        preview: { baseCommit: "base", changeSetCommit: "base", fileCount: 0, files: [], diff: "" },
        integratedNodeIds: ["work"],
      };
    },
  };
  const runtime = new PipelineRuntime(adapter, { programs: [program], store });

  const completed = await runtime.recover("run-recover-before-promotion");

  assert.equal(completed.status, "completed");
  assert.equal(sessions, 0);
  assert.equal(finalizations, 1);
  assert.equal(completed.snapshot.sandboxRuns?.["sandbox-work"]?.integrationState, "integrated");
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

test("an Integration Conflict pauses finalization and approval retries only the incoming node", async () => {
  const program = multiAgentProgram();
  const store = new InMemoryPipelineRunStore();
  const attempts: string[] = [];
  const terminalEvents: string[] = [];
  let finalization = 0;
  const adapter: PipelineRuntimeAdapter & {
    finalizePipelineChangeSet(input: PipelineChangeSetFinalizationInput): Promise<PipelineChangeSetFinalizationResult>;
  } = {
    async createSession({ runId, node }) {
      return {
        runId,
        nodeId: node.id,
        async send(input): Promise<PipelineNodeExecutionResult> {
          attempts.push(`${node.id}#${input.attempt}`);
          return {
            artifact: {
              name: "out",
              type: "note",
              format: "text",
              value: `${node.id}#${input.attempt}`,
            },
          };
        },
        async cancel() {},
        async close() {},
      };
    },
    async finalizePipelineChangeSet(input) {
      finalization += 1;
      if (finalization === 1) {
        throw new PipelineIntegrationConflictError({
          runId: input.runId,
          retryNodeId: "b",
          checkpoints: [
            { nodeId: "a", attempt: 1, commit: "a-1", ref: "refs/checkpoints/a-1" },
            { nodeId: "b", attempt: 1, commit: "b-1", ref: "refs/checkpoints/b-1" },
          ],
          files: ["src/shared.ts"],
        });
      }
      return noChangesResult(input);
    },
  };
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-integration-conflict",
    store,
    onEvent: event => {
      if (["paused", "completed", "failed"].includes(event.type)) terminalEvents.push(event.type);
    },
  });

  const paused = await runtime.start(program);

  assert.equal(paused.status, "paused");
  assert.equal(paused.snapshot.pendingPause?.type, "approval");
  assert.equal(paused.snapshot.pendingPause?.integrationConflict?.retryNodeId, "b");
  assert.match(paused.snapshot.pendingPause?.content ?? "", /a, tentative 1/);
  assert.match(paused.snapshot.pendingPause?.content ?? "", /b, tentative 1/);
  assert.match(paused.snapshot.pendingPause?.content ?? "", /src\/shared\.ts/);
  assert.match(paused.snapshot.pendingPause?.content ?? "", /Aucun changement n'a été transféré vers le workspace hôte/);
  assert.deepEqual(terminalEvents, ["paused"]);
  assert.equal((await store.load(paused.runId))?.status, "paused");

  const completed = await runtime.resume(paused.runId, {
    pauseId: paused.status === "paused" ? paused.pause.id : "unreachable",
    kind: "approve",
  });

  assert.equal(completed.status, "completed");
  assert.deepEqual(attempts.filter(attempt => attempt.startsWith("a#")), ["a#1"]);
  assert.deepEqual(attempts.filter(attempt => attempt.startsWith("b#")), ["b#1", "b#2"]);
  assert.deepEqual(attempts.filter(attempt => attempt.startsWith("c#")), ["c#1"]);
  assert.deepEqual(attempts.filter(attempt => attempt.startsWith("join#")), ["join#1"]);
  assert.equal(finalization, 2);
  assert.deepEqual(
    (completed as typeof completed & { changeSet?: PipelineChangeSetFinalizationResult }).changeSet?.integratedNodeIds,
    ["a", "b", "c"],
  );
  assert.deepEqual(terminalEvents, ["paused", "completed"]);
});

test("a sandbox resume divergence pauses without relaunch and approval only retries reconciliation", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "resume-divergence",
    title: "Resume divergence",
    nodes: [{
      id: "work", agent: "Codex", prompt: "Work",
      output: { name: "out", type: "note", format: "text" },
    }],
  }, agents).program!;
  const attempts: number[] = [];
  let reconciliations = 0;
  const adapter: PipelineRuntimeAdapter & {
    finalizePipelineChangeSet(input: PipelineChangeSetFinalizationInput): Promise<PipelineChangeSetFinalizationResult>;
  } = {
    async createSession({ runId, node }) {
      return {
        runId,
        nodeId: node.id,
        async send(input) {
          attempts.push(input.attempt ?? 0);
          await input.onSandboxRunState?.({
            sandboxName: "sandbox-work", runId, nodeId: node.id, attempt: input.attempt ?? 1,
            baseCommit: "base", integrationState: "checkpointed", resourceState: "active",
            checkpoint: {
              status: "checkpointed", commit: "checkpoint", remote: "sandbox-sandbox-work", ref: "refs/checkpoints/work",
              preview: { baseCommit: "base", checkpointCommit: "checkpoint", fileCount: 1, files: ["work.ts"], diff: "diff" },
            },
          });
          return { artifact: { name: "out", type: "note", format: "text", value: "done" } };
        },
        async cancel() {},
        async close() {},
      };
    },
    async finalizePipelineChangeSet(input) {
      reconciliations += 1;
      if (reconciliations === 1) {
        throw new PipelineSandboxResumeDivergenceError({
          runId: input.runId,
          sandboxName: "sandbox-work",
          nodeId: "work",
          attempt: 1,
          diagnostic: "Sandbox identity divergence: observed foreign, expected stable.",
        });
      }
      return {
        promotion: "no_changes",
        preview: { baseCommit: "base", changeSetCommit: "base", fileCount: 0, files: [], diff: "" },
        integratedNodeIds: ["work"],
      };
    },
  };
  const store = new InMemoryPipelineRunStore();
  const firstRuntime = new PipelineRuntime(adapter, { runIdFactory: () => "run-resume-divergence", store });
  const paused = await firstRuntime.start(program);

  assert.equal(paused.status, "paused");
  assert.equal(paused.snapshot.pendingPause?.sandboxResumeDivergence?.sandboxName, "sandbox-work");
  assert.equal(paused.snapshot.sandboxRuns?.["sandbox-work"]?.integrationState, "resume_divergence");
  assert.match(paused.status === "paused" ? paused.pause.content : "", /No agent was relaunched/);

  const restoredRuntime = new PipelineRuntime(adapter, { programs: [program], store });
  const completed = await restoredRuntime.resume(paused.runId, {
    pauseId: paused.status === "paused" ? paused.pause.id : "unreachable",
    kind: "approve",
  });

  assert.equal(completed.status, "completed");
  assert.deepEqual(attempts, [1]);
  assert.equal(reconciliations, 2);
});

test("an Integration Conflict remains retryable without a persistent run store", async () => {
  const program = multiAgentProgram();
  let finalization = 0;
  const adapter = successfulAdapter(async input => {
    finalization += 1;
    if (finalization === 1) {
      throw new PipelineIntegrationConflictError({
        runId: input.runId,
        retryNodeId: "b",
        checkpoints: [
          { nodeId: "a", attempt: 1, commit: "a-1", ref: "refs/checkpoints/a-1" },
          { nodeId: "b", attempt: 1, commit: "b-1", ref: "refs/checkpoints/b-1" },
        ],
        files: ["src/shared.ts"],
      });
    }
    return noChangesResult(input);
  });
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-in-memory-integration-conflict",
  });

  const paused = await runtime.start(program);
  assert.equal(paused.status, "paused");

  const completed = await runtime.resume(paused.runId, {
    pauseId: paused.status === "paused" ? paused.pause.id : "unreachable",
    kind: "approve",
  });

  assert.equal(completed.status, "completed");
  assert.equal(finalization, 2);
});

test("completed runs do not remain retained by the fallback store", async () => {
  const program = multiAgentProgram();
  const adapterWithFinalizer = successfulAdapter(async input => noChangesResult(input));
  const adapter: PipelineRuntimeAdapter = {
    createSession: adapterWithFinalizer.createSession,
  };
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-ephemeral-completion",
  });

  const completed = await runtime.start(program);

  assert.equal(completed.status, "completed");
  assert.equal(await runtime.inspect(completed.runId), null);
});

test("failed runs do not remain retained by the fallback store", async () => {
  const program = multiAgentProgram();
  const adapter: PipelineRuntimeAdapter = {
    async createSession({ runId, node }) {
      return {
        runId,
        nodeId: node.id,
        async send(): Promise<PipelineNodeExecutionResult> {
          return { code: "node_failed", message: "node failed", retryable: false };
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-ephemeral-failure",
  });

  const failed = await runtime.start(program);

  assert.equal(failed.status, "failed");
  assert.equal(await runtime.inspect(failed.runId), null);
});

test("cancelled runs do not remain retained by the fallback store", async () => {
  const program = multiAgentProgram();
  const adapter = successfulAdapter(async input => {
    throw new PipelineIntegrationConflictError({
      runId: input.runId,
      retryNodeId: "b",
      checkpoints: [
        { nodeId: "a", attempt: 1, commit: "a-1", ref: "refs/checkpoints/a-1" },
        { nodeId: "b", attempt: 1, commit: "b-1", ref: "refs/checkpoints/b-1" },
      ],
      files: ["src/shared.ts"],
    });
  });
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-ephemeral-cancellation",
  });

  const paused = await runtime.start(program);
  assert.equal(paused.status, "paused");

  const cancelled = await runtime.cancel(paused.runId);

  assert.equal(cancelled.status, "cancelled");
  assert.equal(await runtime.inspect(cancelled.runId), null);
});

test("persists a completed run before notifying a failing observer", async () => {
  const program = multiAgentProgram();
  const store = new InMemoryPipelineRunStore();
  const adapterWithFinalizer = successfulAdapter(async input => noChangesResult(input));
  const adapter: PipelineRuntimeAdapter = {
    createSession: adapterWithFinalizer.createSession,
  };
  const runtime = new PipelineRuntime(adapter, {
    runIdFactory: () => "run-failing-completed-observer",
    store,
    onEvent: event => {
      if (event.type === "completed") {
        throw new Error("completed observer unavailable");
      }
    },
  });

  await assert.rejects(
    runtime.start(program),
    /completed observer unavailable/,
  );

  assert.equal((await store.load("run-failing-completed-observer"))?.status, "completed");
  assert.deepEqual(
    (await store.readEvents("run-failing-completed-observer"))
      .map(event => event.type)
      .filter(type => type === "completed"),
    ["completed"],
  );
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
