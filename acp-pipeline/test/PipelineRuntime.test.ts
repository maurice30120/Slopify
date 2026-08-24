import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  PipelineRuntime,
  compilePipelineV3Definition,
  InMemoryPipelineRunStore,
  NATIVE_ACP_BASELINE_CAPABILITIES,
  PIPELINE_NODE_ACP_HISTORY_ARTIFACT_NAME,
  PIPELINE_NODE_ACP_HISTORY_ARTIFACT_TYPE,
  type PipelineNodeExecutionInput,
  type PipelineNodeExecutionResult,
  type PipelineInterviewSnapshot,
  type PipelineRunStore,
  type PipelineRuntimeEvent,
  type PipelineRuntimeSnapshot,
  type PipelineRuntimeAdapter,
  compileExecutionPlan,
} from "../dist/index.js";

const agents = { Codex: {} };

function sessionAdapter(
  execute: (input: PipelineNodeExecutionInput) => Promise<PipelineNodeExecutionResult>,
): PipelineRuntimeAdapter {
  return {
    async execute(input) {
      return execute(input);
    },
    async createSession({ runId, node }) {
      return {
        runId,
        nodeId: node.id,
        send: execute,
        async cancel() {},
        async close() {},
      };
    },
  };
}

function executionPlanArtifact(nodeId: string): PipelineNodeExecutionResult {
  return { artifact: nodeId === "final-review"
    ? { name: "review", type: "acp.verification-report/v1", format: "json", value: {
      contract: "acp.verification-report/v1", verdict: "passed", categories: [],
    } }
    : { name: "result", type: "acp.implementation-result/v1", format: "json", value: {
      contract: "acp.implementation-result/v1", ticketId: nodeId, branch: nodeId,
      commits: [nodeId], summary: nodeId, validations: [],
    } },
  };
}

test("PipelineRuntime completes a linear pipeline with strict inputs and final artifact", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "linear",
    title: "Linear",
    nodes: [
      {
        id: "first",
        agent: "Codex",
        prompt: "first",
        output: { name: "out", type: "text-note", format: "text" },
      },
      {
        id: "second",
        agent: "Codex",
        prompt: "second",
        needs: ["first"],
        inputs: [{ name: "first", from: "first.out", type: "text-note", format: "text" }],
        output: { name: "out", type: "text-note", format: "text" },
      },
    ],
  }, agents).program!;
  const adapter: PipelineRuntimeAdapter = sessionAdapter(async ({ node, inputs }) => {
      return {
        artifact: {
          name: "out",
          type: "text-note",
          format: "text",
          value: node.id === "first" ? "one" : `two:${inputs.first.value}`,
        },
      };

  });
  const runtime = new PipelineRuntime(adapter, { runIdFactory: () => "run-1" });

  const result = await runtime.start(program);

  assert.equal(result.status, "completed");
  assert.equal(result.artifact?.value, "two:one");
  assert.equal(result.snapshot.nodeStates.first.status, "completed");
  assert.equal(result.snapshot.nodeStates.second.status, "completed");
});

test("PipelineRuntime renders node prompts from start inputs and typed artifacts", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "render",
    title: "Render",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan {{userPrompt}}",
        output: { name: "out", type: "text-note", format: "text" },
      },
      {
        id: "implement",
        agent: "Codex",
        prompt: "Implement {{inputs.planText}} for {{userPrompt}}",
        needs: ["plan"],
        inputs: [{ name: "planText", from: "plan.out", type: "text-note", format: "text" }],
        output: { name: "out", type: "text-note", format: "text" },
      },
    ],
  }, agents).program!;
  const prompts: string[] = [];
  const adapter: PipelineRuntimeAdapter = sessionAdapter(async ({ node, prompt }) => {
      prompts.push(prompt);
      return {
        artifact: {
          name: "out",
          type: "text-note",
          format: "text",
          value: node.id === "plan" ? "approved plan" : prompt,
        },
      };

  });

  const runtime = new PipelineRuntime(adapter, { runIdFactory: () => "run-render" });
  const result = await runtime.start(program, { inputs: { userPrompt: "ship feature" } });

  assert.equal(result.status, "completed");
  assert.deepEqual(prompts, [
    "Plan ship feature",
    "Implement approved plan for ship feature",
  ]);
  assert.equal(result.snapshot.inputVariables?.userPrompt, "ship feature");
});

test("PipelineRuntime persists one immutable Execution Plan and restores its expansion state", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "execution-plan-snapshot",
    title: "Execution plan snapshot",
    nodes: [{
      id: "approval",
      type: "pause",
      pause: "approval",
      content: "Continue?",
    }],
  }, agents).program!;
  const plan = compileExecutionPlan({
    contract: "acp.ticket-graph/v1",
    tickets: [{ id: "T01", title: "One", scope: [], needs: [], validation: [] }],
  }).plan!;
  const store = new InMemoryPipelineRunStore();
  const firstRuntime = new PipelineRuntime(sessionAdapter(async () => {
    throw new Error("pause nodes do not execute through the adapter");
  }), { runIdFactory: () => "run-plan", store });

  const paused = await firstRuntime.start(program, { executionPlan: plan });
  assert.equal(paused.status, "paused");
  assert.equal(paused.snapshot.executionPlan?.expansion.status, "expanded");
  assert.deepEqual(paused.snapshot.executionPlan?.expansion.expandedNodeIds, ["T01", "final-review"]);
  assert.ok(paused.snapshot.executionPlan?.expansion.status === "expanded"
    && !Number.isNaN(Date.parse(paused.snapshot.executionPlan.expansion.expandedAt)));

  const restoredRuntime = new PipelineRuntime(sessionAdapter(async ({ node }) => {
    return executionPlanArtifact(node.id);
  }), { store, programs: [program] });
  const completed = await restoredRuntime.resume("run-plan", {
    pauseId: paused.pause.id,
    kind: "approve",
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.snapshot.executionPlan, paused.snapshot.executionPlan);
});

test("PipelineRuntime compiles and persists a Ticket Graph before the first implementation starts", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "compile-ticket-graph",
    title: "Compile ticket graph",
    nodes: [
      {
        id: "tasks",
        agent: "Codex",
        prompt: "Create tasks",
        output: { name: "graph", type: "acp.ticket-graph/v1", format: "json" },
      },
    ],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  const runtime = new PipelineRuntime(sessionAdapter(async ({ node }) => {
    if (node.id === "tasks") {
      return { artifact: { name: "graph", type: "acp.ticket-graph/v1", format: "json", value: {
        contract: "acp.ticket-graph/v1",
        tickets: [{ id: "T01", title: "One", scope: [], needs: [], validation: [] }],
      } } };
    }
    const durable = await store.load("run-auto-plan");
    assert.equal(durable?.executionPlan?.plan.nodes[0].id, "T01");
    assert.equal(durable?.executionPlan?.expansion.status, "expanded");
    assert.deepEqual(durable?.executionPlan?.expansion.expandedNodeIds, ["T01", "final-review"]);
    return executionPlanArtifact(node.id);
  }), { runIdFactory: () => "run-auto-plan", store });

  const result = await runtime.start(program);
  assert.equal(result.status, "completed");
  assert.equal(result.snapshot.executionPlan?.plan.contract, "acp.execution-plan/v1");
});

test("PipelineRuntime rejects an unsupported structured Ticket Graph version", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "unsupported-ticket-graph",
    title: "Unsupported ticket graph",
    nodes: [{
      id: "tasks",
      agent: "Codex",
      prompt: "Create tasks",
      output: { name: "graph", type: "acp.ticket-graph/v2", format: "json" },
    }],
  }, agents).program!;
  const runtime = new PipelineRuntime(sessionAdapter(async () => ({
    artifact: { name: "graph", type: "acp.ticket-graph/v2", format: "json", value: {
      contract: "acp.ticket-graph/v2",
      tickets: [],
    } },
  })));

  const result = await runtime.start(program);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "unsupported_ticket_graph_version");
  assert.match(result.error.message, /acp\.ticket-graph\/v2/);
});

test("PipelineRuntime renders pause content from typed inputs", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "pause-render",
    title: "Pause Render",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        output: { name: "out", type: "text-note", format: "markdown" },
      },
      {
        id: "approval",
        type: "pause",
        pause: "approval",
        content: "Approve {{inputs.planText}} for {{userPrompt}}",
        handoff: { kind: "workspace-files", minimumReferences: 1 },
        needs: ["plan"],
        inputs: [{ name: "planText", from: "plan.out", type: "text-note", format: "markdown" }],
        output: { name: "approved", type: "approval", format: "markdown" },
      },
    ],
  }, agents).program!;
  const adapter: PipelineRuntimeAdapter = sessionAdapter(async () => {
      return {
        artifact: {
          name: "out",
          type: "text-note",
          format: "markdown",
          value: "the plan",
        },
      };

  });

  const runtime = new PipelineRuntime(adapter, { runIdFactory: () => "run-pause-render" });
  const result = await runtime.start(program, { inputs: { userPrompt: "ship feature" } });

  assert.equal(result.status, "paused");
  assert.equal(result.pause.content, "Approve the plan for ship feature");
  assert.deepEqual(result.pause.handoff, { kind: "workspace-files", minimumReferences: 1 });
});

test("PipelineRuntime supports multiple stable pauses and rejects obsolete resumes", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "pauses",
    title: "Pauses",
    nodes: [
      {
        id: "approvePlan",
        type: "pause",
        pause: "approval",
        content: "Approve?",
        format: "proposed-plan",
        output: { name: "decision", type: "approval", format: "text" },
      },
      {
        id: "question",
        type: "pause",
        pause: "question",
        content: "Question?",
        needs: ["approvePlan"],
        output: { name: "answer", type: "answer", format: "text" },
      },
      {
        id: "final",
        agent: "Codex",
        prompt: "final",
        needs: ["question"],
        inputs: [{ name: "answer", from: "question.answer", type: "answer", format: "text" }],
        output: { name: "out", type: "text-note", format: "text" },
      },
    ],
  }, agents).program!;
  const runtime = new PipelineRuntime(sessionAdapter(async ({ inputs }) => {
      return { artifact: { name: "out", type: "text-note", format: "text", value: inputs.answer.value } };

  }), { runIdFactory: () => "run-paused" });

  const first = await runtime.start(program);
  assert.equal(first.status, "paused");
  assert.equal(first.pause.type, "approval");

  const second = await runtime.resume(first.runId, { pauseId: first.pause.id, kind: "approve", value: "yes" });
  assert.equal(second.status, "paused");
  assert.equal(second.pause.type, "question");

  const obsolete = await runtime.resume(first.runId, { pauseId: first.pause.id, kind: "answer", value: "old" });
  assert.equal(obsolete.status, "failed");
  assert.equal(obsolete.error.code, "invalid_resume");

  const final = await runtime.resume(second.runId, { pauseId: second.pause.id, kind: "answer", value: "42" });
  assert.equal(final.status, "completed");
  assert.equal(final.artifact?.value, "42");
});

test("PipelineRuntime resumes a persisted pause after runtime reconstruction", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "persisted",
    title: "Persisted",
    nodes: [
      {
        id: "question",
        type: "pause",
        pause: "question",
        content: "Question?",
        output: { name: "answer", type: "answer", format: "text" },
      },
      {
        id: "final",
        agent: "Codex",
        prompt: "final",
        needs: ["question"],
        inputs: [{ name: "answer", from: "question.answer", type: "answer", format: "text" }],
        output: { name: "out", type: "text-note", format: "text" },
      },
    ],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  const firstRuntime = new PipelineRuntime(sessionAdapter(async () => {
      throw new Error("first runtime should not execute after pause");

  }), { runIdFactory: () => "run-restored", store });
  const paused = await firstRuntime.start(program);
  assert.equal(paused.status, "paused");

  const restoredRuntime = new PipelineRuntime(sessionAdapter(async ({ inputs }) => {
      return { artifact: { name: "out", type: "text-note", format: "text", value: inputs.answer.value } };

  }), { store, programs: [program] });

  const completed = await restoredRuntime.resume(paused.runId, {
    pauseId: paused.pause.id,
    kind: "answer",
    value: "restored",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact?.value, "restored");
});

test("PipelineRuntime emits telemetry through options without EventEmitter surface", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "events",
    title: "Events",
    nodes: [
      {
        id: "only",
        agent: "Codex",
        prompt: "only",
        output: { name: "out", type: "note", format: "text" },
      },
    ],
  }, agents).program!;
  const events: string[] = [];
  const runtime = new PipelineRuntime(sessionAdapter(async () => {
      return { artifact: { name: "out", type: "note", format: "text", value: "ok" } };

  }), {
    runIdFactory: () => "run-events",
    onEvent: event => {
      events.push(event.type);
    },
  });

  await runtime.start(program);

  assert.deepEqual(events, ["run_started", "node_started", "node_completed", "completed"]);
  assert.equal(typeof (runtime as unknown as { on?: unknown }).on, "undefined");
});

test("PipelineRuntime runs ready nodes together and retries transient failures", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "parallel",
    title: "Parallel",
    nodes: [
      {
        id: "a",
        agent: "Codex",
        prompt: "A",
        retry: { maxAttempts: 2, backoffMs: 0 },
        output: { name: "out", type: "note", format: "text" },
      },
      {
        id: "b",
        agent: "Codex",
        prompt: "B",
        output: { name: "out", type: "note", format: "text" },
      },
      {
        id: "join",
        agent: "Codex",
        prompt: "J",
        needs: ["a", "b"],
        inputs: [
          { name: "a", from: "a.out", type: "note", format: "text" },
          { name: "b", from: "b.out", type: "note", format: "text" },
        ],
        output: { name: "out", type: "note", format: "text" },
      },
    ],
  }, agents).program!;
  const starts: string[] = [];
  let aAttempts = 0;
  const runtime = new PipelineRuntime(sessionAdapter(async ({ node, inputs }) => {
      starts.push(node.id);
      if (node.id === "a" && ++aAttempts === 1) {
        return { code: "temporary", message: "try again", retryable: true };
      }
      return {
        artifact: {
          name: "out",
          type: "note",
          format: "text",
          value: node.id === "join" ? `${inputs.a.value}${inputs.b.value}` : node.id,
        },
      };

  }), { runIdFactory: () => "run-parallel" });

  const result = await runtime.start(program);

  assert.equal(result.status, "completed");
  assert.equal(result.artifact?.value, "ab");
  assert.deepEqual(starts.slice(0, 2).sort(), ["a", "b"]);
  assert.equal(result.snapshot.nodeStates.a.attempts, 2);
});

test("PipelineRuntime expands one plan in the main run and respects dependency and concurrency limits", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "dynamic-plan",
    title: "Dynamic plan",
    nodes: [{
      id: "tasks",
      agent: "Codex",
      prompt: "Create tasks",
      output: { name: "graph", type: "acp.ticket-graph/v1", format: "json" },
    }],
  }, agents).program!;
  const active = new Set<string>();
  let peak = 0;
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const waitForRelease = (id: string) => new Promise<void>(resolve => releases.set(id, resolve));
  const runtime = new PipelineRuntime(sessionAdapter(async ({ runId, node }) => {
    assert.equal(runId, "run-dynamic-plan");
    if (node.id === "tasks") {
      return { artifact: { name: "graph", type: "acp.ticket-graph/v1", format: "json", value: {
        contract: "acp.ticket-graph/v1",
        tickets: [
          { id: "left", title: "Left", scope: [], needs: [], validation: [] },
          { id: "right", title: "Right", scope: [], needs: [], validation: [] },
          { id: "join", title: "Join", scope: [], needs: ["left", "right"], validation: [] },
        ],
      } } };
    }
    started.push(node.id);
    active.add(node.id);
    peak = Math.max(peak, active.size);
    if (node.id === "left" || node.id === "right") await waitForRelease(node.id);
    active.delete(node.id);
    return executionPlanArtifact(node.id);
  }), { runIdFactory: () => "run-dynamic-plan" });

  const completion = runtime.start(program, { maxConcurrency: 2 });
  while (!releases.has("left") || !releases.has("right")) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...active].sort(), ["left", "right"]);
  assert.equal(started.includes("join"), false);
  releases.get("left")!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.includes("join"), false);
  releases.get("right")!();

  const result = await completion;
  assert.equal(result.status, "completed");
  assert.equal(peak, 2);
  assert.ok(started.indexOf("join") > started.indexOf("left"));
  assert.ok(started.indexOf("join") > started.indexOf("right"));
  assert.ok(started.indexOf("final-review") > started.indexOf("join"));
  assert.deepEqual(Object.keys(result.snapshot.nodeStates).sort(), ["final-review", "join", "left", "right", "tasks"]);
  assert.deepEqual([...(result.snapshot.executionPlan?.expansion.expandedNodeIds ?? [])].sort(), ["final-review", "join", "left", "right"]);
  assert.equal(result.snapshot.maxConcurrency, 2);
});

test("PipelineRuntime resumes an expanded plan without injecting duplicate nodes", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "resume-dynamic-plan",
    title: "Resume dynamic plan",
    nodes: [
      {
        id: "tasks",
        agent: "Codex",
        prompt: "Create tasks",
        output: { name: "graph", type: "acp.ticket-graph/v1", format: "json" },
      },
      {
        id: "approval",
        type: "pause",
        pause: "approval",
        content: "Continue?",
        needs: ["tasks"],
      },
    ],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  const graph = {
    contract: "acp.ticket-graph/v1" as const,
    tickets: [{ id: "ticket", title: "Ticket", scope: [], needs: [], validation: [] }],
  };
  const firstRuntime = new PipelineRuntime(sessionAdapter(async ({ node }) => {
    assert.equal(node.id, "tasks");
    return { artifact: { name: "graph", type: "acp.ticket-graph/v1", format: "json", value: graph } };
  }), { runIdFactory: () => "run-resume-dynamic", store });
  const paused = await firstRuntime.start(program, { maxConcurrency: 1 });
  assert.equal(paused.status, "paused");
  assert.equal(paused.snapshot.executionPlan?.expansion.status, "expanded");
  assert.deepEqual(paused.snapshot.executionPlan?.expansion.expandedNodeIds, ["ticket", "final-review"]);

  const starts: string[] = [];
  const restoredRuntime = new PipelineRuntime(sessionAdapter(async ({ node }) => {
    starts.push(node.id);
    return executionPlanArtifact(node.id);
  }), { store, programs: [program] });
  const completed = await restoredRuntime.resume("run-resume-dynamic", {
    pauseId: paused.pause.id,
    kind: "approve",
  });

  assert.equal(completed.status, "completed");
  assert.deepEqual(starts, ["ticket", "final-review"]);
  assert.deepEqual(Object.keys(completed.snapshot.nodeStates).sort(), ["approval", "final-review", "tasks", "ticket"]);
  assert.equal(completed.snapshot.maxConcurrency, 1);
});

test("PipelineRuntime recovers a partially executed dynamic plan without restarting completed work", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "recover-dynamic-plan",
    title: "Recover dynamic plan",
    nodes: [{
      id: "tasks",
      agent: "Codex",
      prompt: "Create tasks",
      output: { name: "graph", type: "acp.ticket-graph/v1", format: "json" },
    }],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  const never = new Promise<PipelineNodeExecutionResult>(() => {});
  void new PipelineRuntime(sessionAdapter(async ({ node }) => {
    if (node.id === "tasks") {
      return { artifact: { name: "graph", type: "acp.ticket-graph/v1", format: "json", value: {
        contract: "acp.ticket-graph/v1",
        tickets: [
          { id: "left", title: "Left", scope: [], needs: [], validation: [] },
          { id: "right", title: "Right", scope: [], needs: [], validation: [] },
          { id: "join", title: "Join", scope: [], needs: ["left", "right"], validation: [] },
        ],
      } } };
    }
    if (node.id === "right") return never;
    return executionPlanArtifact(node.id);
  }), { runIdFactory: () => "run-recover-dynamic", store }).start(program, { maxConcurrency: 2 });

  let crashedSnapshot: PipelineRuntimeSnapshot | null = null;
  while (crashedSnapshot?.nodeStates.left.status !== "completed"
    || crashedSnapshot.nodeStates.right.status !== "running") {
    await new Promise(resolve => setImmediate(resolve));
    crashedSnapshot = await store.load("run-recover-dynamic");
  }
  const recoveryStore = new InMemoryPipelineRunStore();
  await recoveryStore.create(crashedSnapshot);
  const restarted: string[] = [];
  const restoredRuntime = new PipelineRuntime(sessionAdapter(async ({ node }) => {
    restarted.push(node.id);
    return executionPlanArtifact(node.id);
  }), { store: recoveryStore, programs: [program] });

  const completed = await restoredRuntime.recover("run-recover-dynamic");

  assert.equal(completed.status, "completed");
  assert.deepEqual(restarted, ["right", "join", "final-review"]);
  assert.equal(completed.snapshot.nodeStates.left.attempts, 1);
  assert.deepEqual(Object.keys(completed.snapshot.nodeStates).sort(), ["final-review", "join", "left", "right", "tasks"]);
});

test("PipelineRuntime fail-fast result preserves diagnostics and cancels pending nodes", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "fail",
    title: "Fail",
    nodes: [
      {
        id: "failer",
        agent: "Codex",
        prompt: "fail",
        output: { name: "out", type: "note", format: "text" },
      },
      {
        id: "after",
        agent: "Codex",
        prompt: "after",
        needs: ["failer"],
        output: { name: "out", type: "note", format: "text" },
      },
    ],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  const runtime = new PipelineRuntime(sessionAdapter(async () => {
      return { code: "boom", message: "failed", retryable: false };

  }), { runIdFactory: () => "run-fail", store });

  const result = await runtime.start(program);

  assert.equal(result.status, "failed");
  assert.equal(result.error.nodeId, "failer");
  assert.equal(result.snapshot.nodeStates.after.status, "cancelled");
  assert.ok(await store.load("run-fail"));
  assert.equal((await store.readEvents("run-fail")).at(-1)?.type, "failed");
});

test("PipelineRuntime refuses unsupported adapter policies before sending prompts", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "policy",
    title: "Policy",
    nodes: [
      {
        id: "networked",
        agent: "Codex",
        prompt: "fetch",
        policy: { network: "enabled" },
        output: { name: "out", type: "note", format: "text" },
      },
    ],
  }, agents).program!;
  let executed = false;
  const runtime = new PipelineRuntime(sessionAdapter(async () => {
      executed = true;
      return { artifact: { name: "out", type: "note", format: "text", value: "bad" } };

  }), {
    runIdFactory: () => "run-policy",
    adapterName: "native ACP",
    adapterCapabilities: NATIVE_ACP_BASELINE_CAPABILITIES,
  });

  const result = await runtime.start(program);

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "unsupported_policy");
  assert.equal(executed, false);
});

test("PipelineRuntime refuses unresolved node skills before sending prompts", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "skills",
    title: "Skills",
    nodes: [
      {
        id: "withSkill",
        agent: "Codex",
        prompt: "use skill",
        skills: ["missing"],
        output: { name: "out", type: "note", format: "text" },
      },
    ],
  }, agents).program!;
  let executed = false;
  const runtime = new PipelineRuntime(sessionAdapter(async () => {
      executed = true;
      return { artifact: { name: "out", type: "note", format: "text", value: "bad" } };

  }), {
    runIdFactory: () => "run-skills",
    resolveNodeSkills: node => node.skills.includes("missing") ? ['Pipeline node references missing skill "missing".'] : [],
  });

  const result = await runtime.start(program);

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "skill_resolution_failed");
  assert.equal(executed, false);
});

test("PipelineRuntime pauses an interview question, records the answer, then produces a ready artifact for approval", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "interview",
    title: "Interview",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan {{userPrompt}}",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
      {
        id: "approval",
        type: "pause",
        pause: "approval",
        content: "{{inputs.plan}}",
        format: "proposed-plan",
        needs: ["plan"],
        inputs: [{ name: "plan", from: "plan.plan", type: "acp.grill-decision/v1", format: "markdown" }],
        output: { name: "approved", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const prompts: string[] = [];
  const runtime = new PipelineRuntime(sessionAdapter(async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedQuestion("Which API?", "Use the public API.") } };
      }
      return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedReady("Use the public API.") } };

  }), { runIdFactory: () => "run-interview" });

  const first = await runtime.start(program, { inputs: { userPrompt: "ship" } });
  assert.equal(first.status, "paused");
  assert.equal(first.pause.type, "question");
  assert.equal(first.pause.content, "Which API?");
  assert.equal(first.pause.recommendation, "Use the public API.");
  assert.equal(first.snapshot.pendingPause?.content, "Which API?");
  assert.equal(first.snapshot.pendingPause?.recommendation, "Use the public API.");
  assert.equal(first.snapshot.nodeStates.plan.status, "paused");
  assert.equal(first.snapshot.artifacts["plan.plan"], undefined);

  const approval = await runtime.resume(first.runId, {
    pauseId: first.pause.id,
    kind: "answer",
    value: "Use the public API",
  });

  assert.equal(approval.status, "paused");
  assert.equal(approval.pause.type, "approval");
  assert.match(approval.pause.content, /Use the public API\./);
  assert.match(prompts[1], /User:\nUse the public API/);
  assert.equal(approval.snapshot.activeInterview, undefined);
  assert.equal(approval.snapshot.nodeInterviewHistories?.plan.originalPrompt, "Plan ship");
  assert.deepEqual(approval.snapshot.nodeInterviewHistories?.plan.turns.map(turn => turn.role), ["agent", "user"]);
  assert.equal(approval.snapshot.artifacts["plan.plan"].value, proposedReady("Use the public API."));
});

test("PipelineRuntime completes an interview with complete-interview and rejects later question output", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "done",
    title: "Done",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  let call = 0;
  const events: string[] = [];
  const runtime = new PipelineRuntime({
    async createSession({ runId, node }) {
      events.push("open");
      return {
        runId,
        nodeId: node.id,
        async send() {
          events.push("send");
          call += 1;
          return {
            artifact: {
              name: "plan",
              type: "acp.grill-decision/v1",
              format: "markdown",
              value: call === 1 ? proposedQuestion("Anything else?") : proposedReady("Final."),
            },
          };
        },
        async cancel() {
          events.push("cancel");
        },
        async close() {
          events.push("close");
        },
      };
    },
  }, { runIdFactory: () => "run-done" });

  const paused = await runtime.start(program);
  assert.equal(paused.status, "paused");

  const completed = await runtime.resume(paused.runId, {
    pauseId: paused.pause.id,
    kind: "complete-interview",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact?.value, proposedReady("Final."));
  assert.deepEqual(events, ["open", "send", "send", "close"]);

  const badRuntime = new PipelineRuntime(sessionAdapter(async () => {
      return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedQuestion("Nope?") } };

  }), { runIdFactory: () => "run-bad-done" });
  const badPaused = await badRuntime.start(program);
  assert.equal(badPaused.status, "paused");
  const failed = await badRuntime.resume(badPaused.runId, {
    pauseId: badPaused.pause.id,
    kind: "complete-interview",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "malformed_interview_output");
});

test("PipelineRuntime makes one normalized final output request after complete-interview", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "final-request",
    title: "Final Request",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  let call = 0;
  const prompts: string[] = [];
  const runtime = new PipelineRuntime(sessionAdapter(async ({ prompt }) => {
      prompts.push(prompt);
      call += 1;
      return {
        artifact: {
          name: "plan",
          type: "acp.grill-decision/v1",
          format: "markdown",
          value: call === 1 ? proposedQuestion("Anything else?")
            : call === 2 ? "missing final artifact"
              : proposedReady("Final."),
        },
      };

  }), { runIdFactory: () => "run-final-request" });

  const paused = await runtime.start(program);
  assert.equal(paused.status, "paused");

  const completed = await runtime.resume(paused.runId, {
    pauseId: paused.pause.id,
    kind: "complete-interview",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact?.value, proposedReady("Final."));
  assert.match(prompts[2], /Return only one valid <proposed_plan> block with <interview_state>ready<\/interview_state>/);
  assert.equal(completed.snapshot.nodeInterviewHistories?.plan.finalOutputRequestsUsed, 1);
});

test("PipelineRuntime fails after one invalid final output request without using interview repairs", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "final-request-fails-once",
    title: "Final Request Fails Once",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        interaction: { protocol: "proposed-plan", repairAttempts: 2 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const prompts: string[] = [];
  const events: string[] = [];
  let call = 0;
  const runtime = new PipelineRuntime({
    async createSession({ runId, node }) {
      events.push("open");
      return {
        runId,
        nodeId: node.id,
        async send({ prompt }) {
          events.push("send");
          prompts.push(prompt);
          call += 1;
          return {
            artifact: {
              name: "plan",
              type: "acp.grill-decision/v1",
              format: "markdown",
              value: call === 1 ? proposedQuestion("Anything else?") : "missing final artifact",
            },
          };
        },
        async cancel() {
          events.push("cancel");
        },
        async close() {
          events.push("close");
        },
      };
    },
  }, { runIdFactory: () => "run-final-request-fails-once" });

  const paused = await runtime.start(program);
  assert.equal(paused.status, "paused");

  const failed = await runtime.resume(paused.runId, {
    pauseId: paused.pause.id,
    kind: "complete-interview",
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "malformed_interview_output");
  assert.match(failed.error.message, /<proposed_plan>/);
  assert.equal(call, 3);
  assert.equal(prompts.filter(prompt => /Final output error:/.test(prompt)).length, 1);
  assert.equal(prompts.filter(prompt => /Protocol error:/.test(prompt)).length, 0);
  assert.equal(failed.snapshot.nodeInterviewHistories?.plan.finalOutputRequestsUsed, 1);
  assert.equal(failed.snapshot.nodeInterviewHistories?.plan.repairAttemptsUsed, 0);
  assert.equal(failed.snapshot.nodeStates.plan.status, "failed");
  assert.deepEqual(events, ["open", "send", "send", "send", "close"]);
});

test("PipelineRuntime restores a multi-turn interview from snapshot replay and rejects obsolete answers", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "restore-interview",
    title: "Restore Interview",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan {{userPrompt}}",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  const firstRuntime = new PipelineRuntime(sessionAdapter(async () => {
      return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedQuestion("First?") } };

  }), { runIdFactory: () => "run-restore-interview", store });
  const first = await firstRuntime.start(program, { inputs: { userPrompt: "ship" } });
  assert.equal(first.status, "paused");
  const firstPauseId = first.pause.id;

  const prompts: string[] = [];
  let call = 0;
  const secondRuntime = new PipelineRuntime(sessionAdapter(async ({ prompt }) => {
      prompts.push(prompt);
      call += 1;
      return {
        artifact: {
          name: "plan",
          type: "acp.grill-decision/v1",
          format: "markdown",
          value: call === 1 ? proposedQuestion("Second?") : proposedReady("Done."),
        },
      };
  }), { store, programs: [program] });

  const second = await secondRuntime.resume(first.runId, {
    pauseId: firstPauseId,
    kind: "answer",
    value: "first answer",
  });
  assert.equal(second.status, "paused");
  assert.notEqual(second.pause.id, firstPauseId);
  assert.match(prompts[0], /Agent:\n<proposed_plan>/);
  assert.match(prompts[0], /User:\nfirst answer/);

  const obsolete = await secondRuntime.resume(first.runId, {
    pauseId: firstPauseId,
    kind: "answer",
    value: "late",
  });
  assert.equal(obsolete.status, "failed");
  assert.equal(obsolete.error.code, "invalid_resume");
});

test("PipelineRuntime persists node ACP history as structured replay artifact after each meaningful interview exchange", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "history-artifact",
    title: "History Artifact",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan {{userPrompt}}",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  const prompts: string[] = [];
  const historyArtifactKey = `plan.${PIPELINE_NODE_ACP_HISTORY_ARTIFACT_NAME}`;
  const outputs = [
    proposedQuestion("First?"),
    proposedQuestion("Second?"),
    proposedReady("Done."),
  ];
  const runtime = new PipelineRuntime({
    async createSession({ runId, node }) {
      return {
        runId,
        nodeId: node.id,
        onActivity(handler) {
          handler({ kind: "message", content: "debug chunk that must not enter replay" });
          return () => {};
        },
        async send({ prompt }) {
          prompts.push(prompt);
          return {
            artifact: {
              name: "plan",
              type: "acp.grill-decision/v1",
              format: "markdown",
              value: outputs.shift(),
            },
          };
        },
        async cancel() {},
        async close() {},
      };
    },
  }, { runIdFactory: () => "run-history-artifact", store });

  const first = await runtime.start(program, { inputs: { userPrompt: "ship" } });
  assert.equal(first.status, "paused");
  const firstStored = await store.load(first.runId);
  const firstHistory = firstStored?.artifacts[historyArtifactKey];
  assert.equal(firstHistory?.name, PIPELINE_NODE_ACP_HISTORY_ARTIFACT_NAME);
  assert.equal(firstHistory?.type, PIPELINE_NODE_ACP_HISTORY_ARTIFACT_TYPE);
  assert.equal(firstHistory?.format, "json");
  const firstHistoryValue = firstHistory?.value as PipelineInterviewSnapshot;
  assert.deepEqual(firstHistoryValue.turns.map(turn => turn.role), ["agent"]);
  assert.match(JSON.stringify(firstHistory?.value), /First\?/);
  assert.doesNotMatch(JSON.stringify(firstHistory?.value), /debug chunk/);

  const second = await runtime.resume(first.runId, {
    pauseId: first.pause.id,
    kind: "answer",
    value: "first answer",
  });
  assert.equal(second.status, "paused");
  const secondStored = await store.load(second.runId);
  const secondHistoryValue = secondStored?.artifacts[historyArtifactKey]?.value as PipelineInterviewSnapshot;
  assert.deepEqual(
    secondHistoryValue.turns.map(turn => turn.role),
    ["agent", "user", "agent"],
  );
  assert.match(JSON.stringify(secondHistoryValue), /first answer/);
  assert.match(prompts[1], /Agent:\n<proposed_plan>/);
  assert.match(prompts[1], /User:\nfirst answer/);
  assert.match(prompts[1], /^Plan ship/);
  assert.doesNotMatch(prompts[1], /debug chunk/);

  const completed = await runtime.resume(second.runId, {
    pauseId: second.pause.id,
    kind: "complete-interview",
  });
  assert.equal(completed.status, "completed");
  const finalHistory = completed.snapshot.artifacts[historyArtifactKey];
  const finalHistoryValue = finalHistory.value as PipelineInterviewSnapshot;
  assert.equal(finalHistoryValue.completionRequested, true);
  assert.deepEqual(
    finalHistoryValue.turns.map(turn => turn.role),
    ["agent", "user", "agent"],
  );
  assert.deepEqual(finalHistoryValue.structuredOutputs?.map(output => output.state), ["ready"]);
  assert.equal(finalHistoryValue.structuredOutputs?.[0]?.content, proposedReady("Done."));

  const inspected = await new PipelineRuntime(sessionAdapter(async () => {
    throw new Error("inspection should not require a live ACP session");
  }), { store, programs: [program] }).inspect(completed.runId);
  assert.equal(inspected?.artifacts[historyArtifactKey]?.type, PIPELINE_NODE_ACP_HISTORY_ARTIFACT_TYPE);
});

test("PipelineRuntime repairs one malformed interview output before failing explicitly", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "repair",
    title: "Repair",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        interaction: { protocol: "proposed-plan", repairAttempts: 1 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  let call = 0;
  const prompts: string[] = [];
  const runtime = new PipelineRuntime(sessionAdapter(async ({ prompt }) => {
      prompts.push(prompt);
      call += 1;
      return {
        artifact: {
          name: "plan",
          type: "acp.grill-decision/v1",
          format: "markdown",
          value: call === 1 ? "not a plan" : proposedReady("Repaired."),
        },
      };

  }), { runIdFactory: () => "run-repair" });

  const result = await runtime.start(program);

  assert.equal(result.status, "completed");
  assert.match(prompts[1], /Protocol error:/);
  assert.equal(result.artifact?.value, proposedReady("Repaired."));

  const failing = new PipelineRuntime(sessionAdapter(async () => {
      return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: "still bad" } };

  }), { runIdFactory: () => "run-repair-fails" });
  const failed = await failing.start(program);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "malformed_interview_output");
});

test("PipelineRuntime gives each interview turn its own repair budget", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "repair-each-turn",
    title: "Repair Each Turn",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        interaction: { protocol: "proposed-plan", repairAttempts: 1 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const outputs = [
    "bad first turn",
    proposedQuestion("First?"),
    "bad second turn",
    proposedReady("Done."),
  ];
  const runtime = new PipelineRuntime(sessionAdapter(async () => {
      return {
        artifact: {
          name: "plan",
          type: "acp.grill-decision/v1",
          format: "markdown",
          value: outputs.shift(),
        },
      };

  }), { runIdFactory: () => "run-repair-each-turn" });

  const paused = await runtime.start(program);
  assert.equal(paused.status, "paused");

  const completed = await runtime.resume(paused.runId, {
    pauseId: paused.pause.id,
    kind: "answer",
    value: "first answer",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact?.value, proposedReady("Done."));
});

test("PipelineRuntime serializes interview nodes while ordinary agents can still run", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "ordered-interviews",
    title: "Ordered Interviews",
    nodes: [
      {
        id: "ordinary",
        agent: "Codex",
        prompt: "ordinary",
        output: { name: "out", type: "note", format: "text" },
      },
      {
        id: "firstInterview",
        agent: "Codex",
        prompt: "first",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
      {
        id: "secondInterview",
        agent: "Codex",
        prompt: "second",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const started: string[] = [];
  const runtime = new PipelineRuntime(sessionAdapter(async ({ node }) => {
      started.push(node.id);
      if (node.id === "ordinary") {
        return { artifact: { name: "out", type: "note", format: "text", value: "ok" } };
      }
      return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedQuestion(`${node.id}?`) } };

  }), { runIdFactory: () => "run-ordered-interviews" });

  const result = await runtime.start(program);

  assert.equal(result.status, "paused");
  assert.equal(result.pause.nodeId, "firstInterview");
  assert.deepEqual(started.sort(), ["firstInterview", "ordinary"]);
  assert.equal(result.snapshot.nodeStates.secondInterview.status, "pending");
  assert.equal(result.snapshot.nodeStates.ordinary.status, "completed");
});

test("PipelineRuntime returns an interview pause without waiting for ordinary independent nodes", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "interview-pause-with-running-ordinary",
    title: "Interview Pause With Running Ordinary",
    nodes: [
      {
        id: "ordinary",
        agent: "Codex",
        prompt: "ordinary",
        output: { name: "out", type: "note", format: "text" },
      },
      {
        id: "firstInterview",
        agent: "Codex",
        prompt: "first",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
      {
        id: "secondInterview",
        agent: "Codex",
        prompt: "second",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const started: string[] = [];
  let releaseOrdinary: ((result: PipelineNodeExecutionResult) => void) | undefined;
  let resolveOrdinaryStarted: (() => void) | undefined;
  const ordinaryStarted = new Promise<void>(resolve => {
    resolveOrdinaryStarted = resolve;
  });
  const runtime = new PipelineRuntime(sessionAdapter(async ({ node }) => {
    started.push(node.id);
    if (node.id === "ordinary") {
      resolveOrdinaryStarted?.();
      return new Promise<PipelineNodeExecutionResult>(resolve => {
        releaseOrdinary = resolve;
      });
    }
    return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedQuestion(`${node.id}?`) } };
  }), { runIdFactory: () => "run-interview-pause-with-running-ordinary" });

  const paused = await runtime.start(program);
  await ordinaryStarted;

  assert.equal(paused.status, "paused");
  assert.equal(paused.pause.nodeId, "firstInterview");
  assert.deepEqual(started.sort(), ["firstInterview", "ordinary"]);
  assert.equal(paused.snapshot.nodeStates.ordinary.status, "running");
  assert.equal(paused.snapshot.nodeStates.secondInterview.status, "pending");

  releaseOrdinary?.({ artifact: { name: "out", type: "note", format: "text", value: "ok" } });
});

test("PipelineRuntime keeps technical retries independent from interview repairs", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "retry-interview",
    title: "Retry Interview",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        retry: { maxAttempts: 2, backoffMs: 0 },
        interaction: { protocol: "proposed-plan", repairAttempts: 1 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  let call = 0;
  const runtime = new PipelineRuntime(sessionAdapter(async () => {
      call += 1;
      if (call === 1) {
        return { code: "temporary", message: "temporary", retryable: true };
      }
      if (call === 2) {
        return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: "bad format" } };
      }
      return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedReady("Ok.") } };

  }), { runIdFactory: () => "run-retry-interview" });

  const result = await runtime.start(program);

  assert.equal(result.status, "completed");
  assert.equal(call, 3);
  assert.equal(result.snapshot.nodeStates.plan.attempts, 2);
  assert.equal(result.snapshot.diagnostics.filter(item => item.code === "temporary").length, 1);
});

test("PipelineRuntime replaces an interview session after retryable transport loss", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "retry-interview-session",
    title: "Retry Interview Session",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        retry: { maxAttempts: 2, backoffMs: 0 },
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const events: string[] = [];
  const runtimeEvents: string[] = [];
  let sessionNumber = 0;
  const runtime = new PipelineRuntime({
    async createSession({ node }) {
      sessionNumber += 1;
      const current = sessionNumber;
      events.push(`open:${current}`);
      return {
        runId: "run-retry-interview-session",
        nodeId: node.id,
        async send({ replay }) {
          events.push(`send:${current}:${replay ? "replay" : "live"}`);
          return current === 1
            ? { code: "transport_lost", message: "lost", retryable: true }
            : { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedReady("Done.") } };
        },
        async cancel() {
          events.push(`cancel:${current}`);
        },
        async close() {
          events.push(`close:${current}`);
        },
      };
    },
    async execute() {
      throw new Error("createSession should be used");
    },
  }, {
    runIdFactory: () => "run-retry-interview-session",
    onEvent: event => {
      runtimeEvents.push(event.type);
    },
  });

  const result = await runtime.start(program);

  assert.equal(result.status, "completed");
  assert.deepEqual(events, ["open:1", "send:1:live", "close:1", "open:2", "send:2:replay", "close:2"]);
  assert.equal(runtimeEvents.filter(type => type === "node_started").length, 1);
  assert.equal(runtimeEvents.filter(type => type === "node_replayed").length, 1);
});

test("PipelineRuntime replays interview history into a replacement session after transport loss", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "replay-interview-history-after-transport-loss",
    title: "Replay Interview History After Transport Loss",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan {{userPrompt}}",
        retry: { maxAttempts: 2, backoffMs: 0 },
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const events: string[] = [];
  const runtimeEvents: string[] = [];
  const prompts: string[] = [];
  let sessionNumber = 0;
  const runtime = new PipelineRuntime({
    async createSession({ runId, node }) {
      sessionNumber += 1;
      const current = sessionNumber;
      events.push(`open:${current}:${runId}:${node.id}`);
      return {
        runId,
        nodeId: node.id,
        async send({ prompt, replay }) {
          prompts.push(prompt);
          events.push(`send:${current}:${replay ? "replay" : "live"}`);
          if (current === 1 && prompts.length === 1) {
            return {
              artifact: {
                name: "plan",
                type: "acp.grill-decision/v1",
                format: "markdown",
                value: proposedQuestion("Which API?"),
              },
            };
          }
          if (current === 1) {
            return { code: "transport_lost", message: "lost", retryable: true };
          }
          return {
            artifact: {
              name: "plan",
              type: "acp.grill-decision/v1",
              format: "markdown",
              value: proposedReady("Use the public API."),
            },
          };
        },
        async cancel() {
          events.push(`cancel:${current}`);
        },
        async close() {
          events.push(`close:${current}`);
        },
      };
    },
  }, {
    runIdFactory: () => "run-replay-interview-history-after-transport-loss",
    onEvent: event => {
      runtimeEvents.push(event.type);
    },
  });

  const paused = await runtime.start(program, { inputs: { userPrompt: "ship" } });
  assert.equal(paused.status, "paused");

  const completed = await runtime.resume(paused.runId, {
    pauseId: paused.pause.id,
    kind: "answer",
    value: "Use the public API",
  });

  assert.equal(completed.status, "completed");
  assert.deepEqual(events, [
    "open:1:run-replay-interview-history-after-transport-loss:plan",
    "send:1:live",
    "send:1:live",
    "close:1",
    "open:2:run-replay-interview-history-after-transport-loss:plan",
    "send:2:replay",
    "close:2",
  ]);
  assert.match(prompts[2], /^Plan ship/);
  assert.match(prompts[2], /Agent:\n<proposed_plan>/);
  assert.match(prompts[2], /Which API\?/);
  assert.match(prompts[2], /User:\nUse the public API/);
  assert.equal(runtimeEvents.filter(type => type === "node_started").length, 1);
  assert.equal(runtimeEvents.filter(type => type === "node_replayed").length, 1);
});

test("PipelineRuntime retries non-transport interview failures without replaying history", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "retry-interview-without-replay",
    title: "Retry Interview Without Replay",
    nodes: [
      {
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        retry: { maxAttempts: 2, backoffMs: 0 },
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const events: string[] = [];
  const runtimeEvents: string[] = [];
  let sessionNumber = 0;
  const runtime = new PipelineRuntime({
    async createSession({ runId, node }) {
      sessionNumber += 1;
      const current = sessionNumber;
      events.push(`open:${current}`);
      return {
        runId,
        nodeId: node.id,
        async send({ replay }) {
          events.push(`send:${current}:${replay ? "replay" : "live"}`);
          return current === 1
            ? { code: "temporary", message: "temporary", retryable: true }
            : { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedReady("Done.") } };
        },
        async cancel() {},
        async close() {
          events.push(`close:${current}`);
        },
      };
    },
  }, {
    runIdFactory: () => "run-retry-interview-without-replay",
    onEvent: event => {
      runtimeEvents.push(event.type);
    },
  });

  const result = await runtime.start(program);

  assert.equal(result.status, "completed");
  assert.deepEqual(events, ["open:1", "send:1:live", "close:1", "open:2", "send:2:live", "close:2"]);
  assert.equal(runtimeEvents.filter(type => type === "node_started").length, 1);
  assert.equal(runtimeEvents.filter(type => type === "node_replayed").length, 0);
});

test("PipelineRuntime does not let an interview pause mask an ordinary node failure", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "interview-with-failure",
    title: "Interview With Failure",
    nodes: [
      {
        id: "ordinary",
        agent: "Codex",
        prompt: "ordinary",
        output: { name: "out", type: "note", format: "text" },
      },
      {
        id: "plan",
        agent: "Codex",
        prompt: "plan",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      },
    ],
  }, agents).program!;
  const runtime = new PipelineRuntime(sessionAdapter(async ({ node }) => {
      if (node.id === "ordinary") {
        return { code: "ordinary_failed", message: "ordinary failed" };
      }
      return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedQuestion("Question?") } };

  }), { runIdFactory: () => "run-interview-with-failure" });

  const result = await runtime.start(program);

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "ordinary_failed");
});

test("PipelineRuntime opens and closes one AgentNodeSession per non-interactive attempt", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "attempt-sessions",
    title: "Attempt Sessions",
    nodes: [{
      id: "work",
      agent: "Codex",
      prompt: "work",
      retry: { maxAttempts: 2, backoffMs: 0 },
      output: { name: "out", type: "note", format: "text" },
    }],
  }, agents).program!;
  const events: string[] = [];
  const runtimeEvents: string[] = [];
  let sends = 0;
  const runtime = new PipelineRuntime({
    async createSession({ node }) {
      events.push(`open:${node.id}`);
      return {
        runId: "run-attempt-sessions",
        nodeId: node.id,
        async send({ replay }) {
          events.push(`send:${node.id}:${replay ? "replay" : "live"}`);
          sends += 1;
          return sends === 1
            ? { code: "transport_lost", message: "lost", retryable: true }
            : { artifact: { name: "out", type: "note", format: "text", value: "ok" } };
        },
        async cancel() {
          events.push(`cancel:${node.id}`);
        },
        async close() {
          events.push(`close:${node.id}`);
        },
      };
    },
    async execute() {
      throw new Error("createSession should be used");
    },
  }, {
    runIdFactory: () => "run-attempt-sessions",
    onEvent: event => {
      runtimeEvents.push(event.type);
    },
  });

  const result = await runtime.start(program);

  assert.equal(result.status, "completed");
  assert.deepEqual(events, ["open:work", "send:work:live", "close:work", "open:work", "send:work:live", "close:work"]);
  assert.equal(runtimeEvents.filter(type => type === "node_replayed").length, 0);
});

test("PipelineRuntime closes a non-interactive AgentNodeSession when send throws", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "attempt-session-throw",
    title: "Attempt Session Throw",
    nodes: [{
      id: "work",
      agent: "Codex",
      prompt: "work",
      output: { name: "out", type: "note", format: "text" },
    }],
  }, agents).program!;
  const events: string[] = [];
  const runtime = new PipelineRuntime({
    async createSession({ runId, node }) {
      events.push("open");
      return {
        runId,
        nodeId: node.id,
        async send() {
          events.push("send");
          throw new Error("transport exploded");
        },
        async cancel() {
          events.push("cancel");
        },
        async close() {
          events.push("close");
        },
      };
    },
  }, { runIdFactory: () => "run-attempt-session-throw" });

  await assert.rejects(() => runtime.start(program), /transport exploded/);
  assert.deepEqual(events, ["open", "send", "close"]);
});

test("PipelineRuntime cancels and closes an in-flight non-interactive AgentNodeSession on run cancel", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "cancel-inflight-attempt-session",
    title: "Cancel Inflight Attempt Session",
    nodes: [{
      id: "work",
      agent: "Codex",
      prompt: "work",
      output: { name: "out", type: "note", format: "text" },
    }],
  }, agents).program!;
  const events: string[] = [];
  let releaseSend: ((result: PipelineNodeExecutionResult) => void) | undefined;
  let resolveSendStarted: (() => void) | undefined;
  const sendStarted = new Promise<void>(resolve => {
    resolveSendStarted = resolve;
  });
  const runtime = new PipelineRuntime({
    async createSession({ runId, node }) {
      events.push("open");
      return {
        runId,
        nodeId: node.id,
        async send() {
          events.push("send");
          resolveSendStarted?.();
          return new Promise<PipelineNodeExecutionResult>(resolve => {
            releaseSend = resolve;
          });
        },
        async cancel() {
          events.push("cancel");
        },
        async close() {
          events.push("close");
        },
      };
    },
  }, { runIdFactory: () => "run-cancel-inflight-attempt-session" });

  const start = runtime.start(program);
  await sendStarted;

  const cancelled = await runtime.cancel("run-cancel-inflight-attempt-session");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.snapshot.finalArtifact, undefined);
  assert.equal(cancelled.snapshot.artifacts["work.out"], undefined);
  assert.deepEqual(events, ["open", "send", "cancel", "close"]);

  releaseSend?.({ artifact: { name: "out", type: "note", format: "text", value: "late" } });
  const settled = await start;
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.snapshot.artifacts["work.out"], undefined);
});

test("PipelineRuntime keeps an interview AgentNodeSession open across user answers and closes it on final artifact", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "interview-session",
    title: "Interview Session",
    nodes: [{
      id: "plan",
      agent: "Codex",
      prompt: "Plan",
      interaction: { protocol: "proposed-plan", repairAttempts: 0 },
      output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
    }],
  }, agents).program!;
  const events: string[] = [];
  let turn = 0;
  const runtimeEvents: string[] = [];
  const runtime = new PipelineRuntime({
    async createSession({ node }) {
      events.push(`open:${node.id}`);
      return {
        runId: "run-interview-session",
        nodeId: node.id,
        async send() {
          turn += 1;
          events.push(`send:${turn}`);
          return {
            artifact: {
              name: "plan",
              type: "acp.grill-decision/v1",
              format: "markdown",
              value: turn === 1 ? proposedQuestion("Continue?") : proposedReady("Done."),
            },
          };
        },
        async cancel() {
          events.push("cancel");
        },
        async close() {
          events.push("close");
        },
      };
    },
    async execute() {
      throw new Error("createSession should be used");
    },
  }, {
    runIdFactory: () => "run-interview-session",
    onEvent: event => {
      runtimeEvents.push(event.type);
    },
  });

  const paused = await runtime.start(program);
  assert.equal(paused.status, "paused");

  const completed = await runtime.resume(paused.runId, {
    pauseId: paused.pause.id,
    kind: "answer",
    value: "yes",
  });

  assert.equal(completed.status, "completed");
  assert.deepEqual(events, ["open:plan", "send:1", "send:2", "close"]);
  assert.equal(runtimeEvents.filter(type => type === "node_started").length, 1);
  assert.equal(runtimeEvents.filter(type => type === "node_replayed").length, 0);
});

test("PipelineRuntime projects temporary agent activity without publishing node artifacts", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "interview-activity",
    title: "Interview Activity",
    nodes: [{
      id: "plan",
      agent: "Codex",
      prompt: "Plan",
      interaction: { protocol: "proposed-plan", repairAttempts: 0 },
      output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
    }],
  }, agents).program!;
  const store = new InMemoryPipelineRunStore();
  const runtimeEvents: { type: string; nodeId?: string; message?: string; activity?: unknown }[] = [];
  let activityHandler: ((activity: { kind: "status"; content: string }) => void) | undefined;
  let unsubscribed = false;
  const runtime = new PipelineRuntime({
    async createSession({ node }) {
      return {
        runId: "run-interview-activity",
        nodeId: node.id,
        onActivity(handler) {
          activityHandler = handler;
          return () => {
            unsubscribed = true;
          };
        },
        async send() {
          activityHandler?.({ kind: "status", content: "thinking about constraints" });
          return {
            artifact: {
              name: "plan",
              type: "acp.grill-decision/v1",
              format: "markdown",
              value: proposedQuestion("Continue?"),
            },
          };
        },
        async cancel() {},
        async close() {},
      };
    },
  }, {
    runIdFactory: () => "run-interview-activity",
    now: () => new Date("2026-07-21T00:00:00.000Z"),
    store,
    onEvent: event => {
      runtimeEvents.push(event);
    },
  });

  const paused = await runtime.start(program);

  assert.equal(paused.status, "paused");
  const activity = runtimeEvents.find(event => event.type === "agent_activity");
  assert.deepEqual(activity, {
    runId: "run-interview-activity",
    type: "agent_activity",
    nodeId: "plan",
    activity: { kind: "status", content: "thinking about constraints" },
    message: "thinking about constraints",
    at: "2026-07-21T00:00:00.000Z",
  });
  assert.equal(paused.snapshot.artifacts["plan.plan"], undefined);
  assert.equal(paused.snapshot.pendingPause?.content, "Continue?");
  assert.equal((await store.readEvents(paused.runId)).some(event => event.type === "agent_activity"), false);

  await runtime.cancel(paused.runId);
  assert.equal(unsubscribed, true);
});

test("PipelineRuntime rejects an AgentNodeSession bound to another run or node", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "session-boundary",
    title: "Session Boundary",
    nodes: [{
      id: "work",
      agent: "Codex",
      prompt: "work",
      output: { name: "out", type: "note", format: "text" },
    }],
  }, agents).program!;
  const events: string[] = [];
  const runtime = new PipelineRuntime({
    async createSession() {
      events.push("open");
      return {
        runId: "another-run",
        nodeId: "another-node",
        async send() {
          events.push("send");
          return { artifact: { name: "out", type: "note", format: "text", value: "wrong" } };
        },
        async cancel() {
          events.push("cancel");
        },
        async close() {
          events.push("close");
        },
      };
    },
  }, { runIdFactory: () => "run-session-boundary" });

  const result = await runtime.start(program);

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "invalid_agent_node_session");
  assert.match(result.error.message, /run-session-boundary/);
  assert.match(result.error.message, /work/);
  assert.deepEqual(events, ["open", "close"]);
});

test("PipelineRuntime cancels and closes the active interview session on reject", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "reject-interview-session",
    title: "Reject Interview Session",
    nodes: [{
      id: "plan",
      agent: "Codex",
      prompt: "Plan",
      interaction: { protocol: "proposed-plan", repairAttempts: 0 },
      output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
    }],
  }, agents).program!;
  const events: string[] = [];
  const runtime = new PipelineRuntime({
    async createSession({ node }) {
      events.push(`open:${node.id}`);
      return {
        runId: "run-reject-interview-session",
        nodeId: node.id,
        async send() {
          events.push("send");
          return {
            artifact: {
              name: "plan",
              type: "acp.grill-decision/v1",
              format: "markdown",
              value: proposedQuestion("Continue?"),
            },
          };
        },
        async cancel() {
          events.push("cancel");
        },
        async close() {
          events.push("close");
        },
      };
    },
    async execute() {
      throw new Error("createSession should be used");
    },
  }, { runIdFactory: () => "run-reject-interview-session" });

  const paused = await runtime.start(program);
  assert.equal(paused.status, "paused");

  const rejected = await runtime.resume(paused.runId, {
    pauseId: paused.pause.id,
    kind: "reject",
  });

  assert.equal(rejected.status, "cancelled");
  assert.equal(rejected.snapshot.finalArtifact, undefined);
  assert.equal(rejected.snapshot.artifacts["plan.plan"], undefined);
  assert.deepEqual(events, ["open:plan", "send", "cancel", "close"]);
});

test("PipelineRuntime closes active sessions after terminal success and failure are persisted", async () => {
  const completedProgram = compilePipelineV3Definition({
    version: 3,
    id: "terminal-success-close-order",
    title: "Terminal Success Close Order",
    nodes: [{
      id: "plan",
      agent: "Codex",
      prompt: "Plan",
      interaction: { protocol: "proposed-plan", repairAttempts: 0 },
      output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
    }],
  }, agents).program!;
  const completedOrder: string[] = [];
  const completedStore = new RecordingRunStore(completedOrder);
  const completedRuntime = new PipelineRuntime({
    async createSession({ runId, node }) {
      return {
        runId,
        nodeId: node.id,
        async send() {
          return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: proposedReady("Done.") } };
        },
        async cancel() {},
        async close() {
          completedOrder.push("close");
        },
      };
    },
  }, { runIdFactory: () => "run-terminal-success-close-order", store: completedStore });

  const completed = await completedRuntime.start(completedProgram);

  assert.equal(completed.status, "completed");
  assert.ok(completedOrder.indexOf("save:running") < completedOrder.indexOf("close"));
  assert.ok(completedOrder.indexOf("event:node_completed") < completedOrder.indexOf("close"));

  const failedProgram = compilePipelineV3Definition({
    version: 3,
    id: "terminal-failure-close-order",
    title: "Terminal Failure Close Order",
    nodes: [{
      id: "plan",
      agent: "Codex",
      prompt: "Plan",
      interaction: { protocol: "proposed-plan", repairAttempts: 0 },
      output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
    }],
  }, agents).program!;
  const failedOrder: string[] = [];
  const failedStore = new RecordingRunStore(failedOrder);
  const failedRuntime = new PipelineRuntime({
    async createSession({ runId, node }) {
      return {
        runId,
        nodeId: node.id,
        async send() {
          return { artifact: { name: "plan", type: "acp.grill-decision/v1", format: "markdown", value: "bad format" } };
        },
        async cancel() {},
        async close() {
          failedOrder.push("close");
        },
      };
    },
  }, { runIdFactory: () => "run-terminal-failure-close-order", store: failedStore });

  const failed = await failedRuntime.start(failedProgram);

  assert.equal(failed.status, "failed");
  assert.deepEqual(failedOrder.slice(-3), ["save:failed", "event:failed", "close"]);
});

function proposedQuestion(question: string, recommendedAnswer?: string): string {
  const lines = [
    "<proposed_plan>",
    "<interview_state>question</interview_state>",
    `<clarification_question>${question}</clarification_question>`,
  ];
  if (recommendedAnswer) {
    lines.push(`<recommended_answer>${recommendedAnswer}</recommended_answer>`);
  }
  lines.push("</proposed_plan>");
  return lines.join("\n");
}

function proposedReady(body: string): string {
  return [
    "<proposed_plan>",
    "<interview_state>ready</interview_state>",
    body,
    "</proposed_plan>",
  ].join("\n");
}

class RecordingRunStore implements PipelineRunStore {
  private readonly delegate = new InMemoryPipelineRunStore();

  constructor(private readonly order: string[]) {}

  async create(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    this.order.push(`create:${snapshot.status}`);
    await this.delegate.create(snapshot);
  }

  async load(runId: string): Promise<PipelineRuntimeSnapshot | null> {
    return this.delegate.load(runId);
  }

  async save(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    this.order.push(`save:${snapshot.status}`);
    await this.delegate.save(snapshot);
  }

  async appendEvent(runId: string, event: PipelineRuntimeEvent): Promise<void> {
    this.order.push(`event:${event.type}`);
    await this.delegate.appendEvent(runId, event);
  }

  async listResumable(): Promise<PipelineRuntimeSnapshot[]> {
    return this.delegate.listResumable();
  }
}
