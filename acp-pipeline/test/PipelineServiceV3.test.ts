import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  PipelineService,
  compilePipelineV3Definition,
  type CompiledPipelineProgram,
  type AgentNodeSessionFactory,
  type AgentNodeSessionTurnInput,
} from "../dist/index.js";

test("PipelineService runs a v3 program through PipelineRuntime with two approvals", async () => {
  const program = createTwoApprovalProgram();
  const calls: AgentNodeSessionTurnInput[] = [];
  const service = new PipelineService(
    () => "/workspace",
    {
      getPipelinePrograms: () => [program],
      getPipelineProgramForAgent: name => name === program.title ? program : null,
      getAgentConfigs: () => ({ Codex: {}, "Codex Sandbox": {} }),
      createSession: createFakeSessionFactory(async input => {
        calls.push(input);
        if (input.node.agent === "Codex") {
          return "spec artifact";
        }
        return "implementation complete";
      }),
    },
  );
  const pauses: string[] = [];
  service.on("plan-ready", (event: any) => pauses.push(event.plan));

  try {
    const firstPause = await service.createPlan("session-v3", "ship it", program.title);
    assert.equal(firstPause, "Approve plan for ship it");
    assert.deepEqual(pauses, ["Approve plan for ship it"]);

    const secondPause = await service.approvePlan("session-v3", "approved plan");
    assert.equal(secondPause, "Approve delivery spec artifact");
    assert.deepEqual(pauses, [
      "Approve plan for ship it",
      "Approve delivery spec artifact",
    ]);

    const output = await service.approvePlan("session-v3", "approved delivery");
    assert.equal(output, "implementation complete");
    assert.deepEqual(calls.map(call => call.prompt), [
      "Write spec for approved plan",
      "Implement approved delivery",
    ]);
    assert.deepEqual(calls.map(call => call.node.agent), ["Codex", "Codex Sandbox"]);
  } finally {
    await service.dispose();
  }
});

test("PipelineService v3 execution requires AgentNodeSession and exposes no runAgent fallback", async () => {
  const program = createSingleAgentProgram();
  const service = new PipelineService(
    () => "/workspace",
    {
      getPipelinePrograms: () => [program],
      getPipelineProgramForAgent: name => name === program.title ? program : null,
      getAgentConfigs: () => ({ Codex: {}, "Codex Sandbox": {} }),
    },
  );

  await assert.rejects(
    () => service.createPlan("session-v3-no-session", "ship it", program.title),
    /requires an AgentNodeSession createSession dependency/,
  );
});

test("PipelineService accepts an AgentNodeSession factory for v3 agent nodes", async () => {
  const program = createSingleAgentProgram();
  const sessions: string[] = [];
  const createSession: AgentNodeSessionFactory = async ({ runId, node }) => {
    sessions.push(`${runId}:${node.id}`);
    return {
      runId,
      nodeId: node.id,
      async send(input) {
        return {
          artifact: {
            name: input.node.output!.name,
            type: input.node.output!.type,
            format: input.node.output!.format,
            value: `session handled ${input.prompt}`,
          },
        };
      },
      async cancel() {},
      async close() {},
    };
  };
  const service = new PipelineService(
    () => "/workspace",
    {
      getPipelinePrograms: () => [program],
      getPipelineProgramForAgent: name => name === program.title ? program : null,
      getAgentConfigs: () => ({ Codex: {} }),
      createSession,
    },
  );

  try {
    const result = await service.startPipeline("session-factory", "ship it", program.title);

    assert.equal(result.status, "completed");
    assert.equal(result.status === "completed" ? result.artifact?.value : "", "session handled Build ship it");
    assert.deepEqual(sessions, ["session-factory:build"]);
  } finally {
    await service.dispose();
  }
});

test("PipelineService cancel clears active v3 runtime sessions", async () => {
  const program = createTwoApprovalProgram();
  const service = new PipelineService(
    () => "/workspace",
    {
      getPipelinePrograms: () => [program],
      getPipelineProgramForAgent: name => name === program.title ? program : null,
      getAgentConfigs: () => ({ Codex: {}, "Codex Sandbox": {} }),
      createSession: createFakeSessionFactory(async () => "spec artifact"),
    },
  );

  try {
    await service.createPlan("session-v3-cancel", "ship it", program.title);
    service.cancel("session-v3-cancel");
    await assert.rejects(
      () => service.approvePlan("session-v3-cancel", "approved"),
      /No pending pipeline pause/,
    );
  } finally {
    await service.dispose();
  }
});

test("PipelineService calls onPipelineStart only for a new v3 pipeline run", async () => {
  const program = createTwoApprovalProgram();
  const starts: string[] = [];
  const service = new PipelineService(
    () => "/workspace",
    {
      getPipelinePrograms: () => [program],
      getPipelineProgramForAgent: name => name === program.title ? program : null,
      getAgentConfigs: () => ({ Codex: {}, "Codex Sandbox": {} }),
      onPipelineStart: input => starts.push(`${input.sessionId}:${input.program.id}:${input.workspaceCwd}`),
      createSession: createFakeSessionFactory(async input => {
        if (input.node.agent === "Codex") {
          return "spec artifact";
        }
        return "implementation complete";
      }),
    },
  );

  try {
    await service.createPlan("session-v3-start", "ship it", program.title);
    await service.approvePlan("session-v3-start", "approved plan");
    await service.approvePlan("session-v3-start", "approved delivery");

    assert.deepEqual(starts, ["session-v3-start:delivery:/workspace"]);
  } finally {
    await service.dispose();
  }
});

test("PipelineService projects v3 pause rejection as rejected", async () => {
  const program = createTwoApprovalProgram();
  const service = new PipelineService(
    () => "/workspace",
    {
      getPipelinePrograms: () => [program],
      getPipelineProgramForAgent: name => name === program.title ? program : null,
      getAgentConfigs: () => ({ Codex: {}, "Codex Sandbox": {} }),
      createSession: createFakeSessionFactory(async () => "spec artifact"),
    },
  );
  const statuses: string[] = [];
  service.on("status", (event: any) => statuses.push(event.status));

  try {
    await service.createPlan("session-v3-reject", "ship it", program.title);
    service.rejectPlan("session-v3-reject");
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.ok(statuses.includes("rejected"));
    assert.ok(!statuses.includes("cancelled"));
  } finally {
    await service.dispose();
  }
});

test("PipelineService exposes generic v3 question resume decisions", async () => {
  const program = compilePipelineV3Definition({
    version: 3,
    id: "question-flow",
    title: "Question Flow",
    nodes: [
      {
        id: "question",
        type: "pause",
        pause: "question",
        content: "Which API?",
        output: { name: "answer", type: "acp.answer/v1", format: "text" },
      },
      {
        id: "finish",
        agent: "Codex",
        prompt: "Use {{inputs.answer}}",
        needs: ["question"],
        inputs: [{ name: "answer", from: "question.answer", type: "acp.answer/v1", format: "text" }],
        output: { name: "result", type: "text", format: "markdown" },
      },
    ],
  }, { Codex: {} }).program!;
  const service = new PipelineService(
    () => "/workspace",
    {
      getPipelinePrograms: () => [program],
      getPipelineProgramForAgent: name => name === program.title ? program : null,
      getAgentConfigs: () => ({ Codex: {} }),
      createSession: createFakeSessionFactory(async input => `done: ${input.prompt}`),
    },
  );
  const pauseTypes: string[] = [];
  service.on("plan-ready", (event: any) => pauseTypes.push(event.pauseType));

  try {
    const started = await service.startPipeline("session-question", "ship it", program.title);
    assert.equal(started.status, "paused");
    assert.equal(started.pause.type, "question");
    assert.equal((await service.getPendingPause("session-question"))?.id, started.pause.id);
    assert.deepEqual(pauseTypes, ["question"]);

    const completed = await service.resumePipeline("session-question", {
      pauseId: started.pause.id,
      kind: "answer",
      value: "public API",
    });

    assert.equal(completed.status, "completed");
    assert.equal(completed.artifact?.value, "done: Use public API");
  } finally {
    await service.dispose();
  }
});

function createTwoApprovalProgram(): CompiledPipelineProgram {
  return compilePipelineV3Definition({
    version: 3,
    id: "delivery",
    title: "Delivery",
    nodes: [
      {
        id: "plan_approval",
        type: "pause",
        pause: "approval",
        content: "Approve plan for {{userPrompt}}",
        output: { name: "approved", type: "acp.grill-decision/v1", format: "markdown" },
      },
      {
        id: "spec",
        agent: "Codex",
        prompt: "Write spec for {{inputs.plan}}",
        needs: ["plan_approval"],
        inputs: [{ name: "plan", from: "plan_approval.approved", type: "acp.grill-decision/v1", format: "markdown" }],
        output: { name: "spec", type: "acp.specification/v1", format: "markdown" },
      },
      {
        id: "delivery_approval",
        type: "pause",
        pause: "approval",
        content: "Approve delivery {{inputs.spec}}",
        needs: ["spec"],
        inputs: [{ name: "spec", from: "spec.spec", type: "acp.specification/v1", format: "markdown" }],
        output: { name: "approved", type: "acp.ticket-graph/v1", format: "markdown" },
      },
      {
        id: "implementation",
        agent: "Codex Sandbox",
        prompt: "Implement {{inputs.delivery}}",
        needs: ["delivery_approval"],
        inputs: [{ name: "delivery", from: "delivery_approval.approved", type: "acp.ticket-graph/v1", format: "markdown" }],
        policy: {
          filesystem: "workspace-write",
          terminal: "workspace-write",
          network: "disabled",
          promotion: "ask",
        },
        output: { name: "result", type: "acp.implementation-result/v1", format: "markdown" },
      },
    ],
  }, { Codex: {}, "Codex Sandbox": {} }).program!;
}

function createSingleAgentProgram(): CompiledPipelineProgram {
  return compilePipelineV3Definition({
    version: 3,
    id: "single-agent",
    title: "Single Agent",
    nodes: [
      {
        id: "build",
        agent: "Codex",
        prompt: "Build {{userPrompt}}",
        output: { name: "result", type: "text", format: "markdown" },
      },
    ],
  }, { Codex: {} }).program!;
}

function createFakeSessionFactory(
  handler: (input: AgentNodeSessionTurnInput) => string | Promise<string>,
): AgentNodeSessionFactory {
  return async ({ runId, node }) => ({
    runId,
    nodeId: node.id,
    async send(input) {
      return {
        artifact: {
          name: input.node.output!.name,
          type: input.node.output!.type,
          format: input.node.output!.format,
          value: await handler(input),
        },
      };
    },
    async cancel() {},
    async close() {},
  });
}
