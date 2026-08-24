import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryPipelineRunStore,
  NATIVE_ACP_BASELINE_CAPABILITIES,
  PipelineRuntime,
  SANDBOX_BASELINE_CAPABILITIES,
  compilePipelineV3Definition,
  type AgentNodeSessionActivity,
  type AgentNodeSessionFactoryInput,
  type PipelineAdapterPolicyCapabilities,
  type PipelineNodeExecutionResult,
  type PipelineRuntimeAdapter,
  type PipelineRuntimeEvent,
} from "../dist/index.js";

const agents = { Codex: {} };

const hostSurfaces: HostSurfaceContract[] = [
  {
    name: "CLI",
    slug: "cli",
    capabilities: NATIVE_ACP_BASELINE_CAPABILITIES,
  },
  {
    name: "Pi",
    slug: "pi",
    capabilities: SANDBOX_BASELINE_CAPABILITIES,
  },
  {
    name: "VS Code",
    slug: "vscode",
    capabilities: SANDBOX_BASELINE_CAPABILITIES,
  },
];

for (const surface of hostSurfaces) {
  test(`${surface.name} AgentNodeSession contract opens, exchanges multiple interview turns, projects temporary activity, and closes`, async () => {
    const program = compilePipelineV3Definition({
      version: 3,
      id: `host-parity-interview-${surface.slug}`,
      title: "Host Parity Interview",
      nodes: [{
        id: "plan",
        agent: "Codex",
        prompt: "Plan {{userPrompt}}",
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      }],
    }, agents).program!;
    const trace: string[] = [];
    const runtimeEvents: PipelineRuntimeEvent[] = [];
    let activityHandler: ((activity: AgentNodeSessionActivity) => void) | undefined;
    let turn = 0;
    const runtime = createRuntime(surface, {
      trace,
      onEvent: event => runtimeEvents.push(event),
      createSend() {
        return async ({ prompt, replay }) => {
          turn += 1;
          trace.push(`send:${turn}:${replay ? "replay" : "live"}`);
          if (turn === 1) {
            assert.match(prompt, /^Plan ship parity/);
            activityHandler?.({ kind: "status", content: `${surface.name} thinking` });
            return agentPlan(proposedQuestion("Which seam?", "Runtime API."));
          }
          assert.match(prompt, /User:\s+Runtime API\./);
          if (turn === 3) {
            return agentPlan(proposedReady("Ready after completion."));
          }
          return agentPlan(proposedQuestion("Anything else?"));
        };
      },
      onActivity(handler) {
        activityHandler = handler;
        return () => trace.push("unsubscribe");
      },
    });

    const firstPause = await runtime.start(program, { inputs: { userPrompt: "ship parity" } });
    assert.equal(firstPause.status, "paused");
    assert.equal(firstPause.pause.content, "Which seam?");
    assert.equal(firstPause.pause.recommendation, "Runtime API.");

    const secondPause = await runtime.resume(firstPause.runId, {
      pauseId: firstPause.pause.id,
      kind: "answer",
      value: "Runtime API.",
    });
    assert.equal(secondPause.status, "paused");
    assert.equal(secondPause.pause.content, "Anything else?");

    const completed = await runtime.resume(secondPause.runId, {
      pauseId: secondPause.pause.id,
      kind: "complete-interview",
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.artifact?.value, proposedReady("Ready after completion."));
    assert.deepEqual(trace, [
      "open:plan",
      "send:1:live",
      "send:2:live",
      "send:3:live",
      "unsubscribe",
      "close:plan",
    ]);
    assert.equal(runtimeEvents.filter(event => event.type === "node_started").length, 1);
    assert.equal(runtimeEvents.filter(event => event.type === "agent_activity").length, 1);
    assert.equal(firstPause.snapshot.artifacts["plan.plan"], undefined);
  });

  test(`${surface.name} AgentNodeSession contract cancels and closes in-flight work`, async () => {
    const program = singleNodeProgram(`host-parity-cancel-${surface.slug}`);
    const trace: string[] = [];
    let releaseSend: ((result: PipelineNodeExecutionResult) => void) | undefined;
    let sendStartedResolve: (() => void) | undefined;
    const sendStarted = new Promise<void>(resolve => {
      sendStartedResolve = resolve;
    });
    const runtime = createRuntime(surface, {
      trace,
      createSend() {
        return async () => {
          trace.push("send:blocked");
          sendStartedResolve?.();
          return new Promise(resolve => {
            releaseSend = resolve;
          });
        };
      },
    });

    const started = runtime.start(program);
    await sendStarted;

    const cancelled = await runtime.cancel(`run-${surface.slug}`);
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(trace, ["open:work", "send:blocked", "cancel:work", "close:work"]);

    releaseSend?.(note("late"));
    await started;
  });

  test(`${surface.name} AgentNodeSession contract classifies failures, retries transport loss, replays interviews, and emits one node_started`, async () => {
    const program = compilePipelineV3Definition({
      version: 3,
      id: `host-parity-replay-${surface.slug}`,
      title: "Host Parity Replay",
      nodes: [{
        id: "plan",
        agent: "Codex",
        prompt: "Plan",
        retry: { maxAttempts: 2, backoffMs: 0 },
        interaction: { protocol: "proposed-plan", repairAttempts: 0 },
        output: { name: "plan", type: "acp.grill-decision/v1", format: "markdown" },
      }],
    }, agents).program!;
    const trace: string[] = [];
    const runtimeEvents: PipelineRuntimeEvent[] = [];
    let sessionNumber = 0;
    const runtime = createRuntime(surface, {
      trace,
      onEvent: event => runtimeEvents.push(event),
      createSend() {
        sessionNumber += 1;
        const current = sessionNumber;
        return async ({ replay }) => {
          trace.push(`send:${current}:${replay ? "replay" : "live"}`);
          return current === 1
            ? { code: "transport_lost", message: "lost", retryable: true }
            : agentPlan(proposedReady("Recovered."));
        };
      },
    });

    const result = await runtime.start(program);

    assert.equal(result.status, "completed");
    assert.equal(result.artifact?.value, proposedReady("Recovered."));
    assert.deepEqual(trace, [
      "open:plan",
      "send:1:live",
      "close:plan",
      "open:plan",
      "send:2:replay",
      "close:plan",
    ]);
    assert.equal(result.snapshot.diagnostics[0]?.code, "transport_lost");
    assert.equal(result.snapshot.diagnostics[0]?.message, "lost");
    assert.equal(runtimeEvents.filter(event => event.type === "node_started").length, 1);
    assert.equal(runtimeEvents.filter(event => event.type === "node_replayed").length, 1);
  });

  test(`${surface.name} AgentNodeSession contract applies policy capability checks before opening and keeps retry close rules stable`, async () => {
    const unsupported = compilePipelineV3Definition({
      version: 3,
      id: `host-parity-policy-denial-${surface.slug}`,
      title: "Host Parity Policy Denial",
      nodes: [{
        id: "work",
        agent: "Codex",
        prompt: "work",
        policy: { network: "enabled" },
        output: { name: "out", type: "note", format: "text" },
      }],
    }, agents).program!;
    const unsupportedTrace: string[] = [];
    const denied = await createRuntime(surface, {
      trace: unsupportedTrace,
      capabilities: NATIVE_ACP_BASELINE_CAPABILITIES,
      createSend: () => async () => note("should not run"),
    }).start(unsupported);
    assert.equal(denied.status, "failed");
    assert.equal(denied.error.code, "unsupported_policy");
    assert.deepEqual(unsupportedTrace, []);

    const retrying = compilePipelineV3Definition({
      version: 3,
      id: `host-parity-retry-close-${surface.slug}`,
      title: "Host Parity Retry Close",
      nodes: [{
        id: "work",
        agent: "Codex",
        prompt: "work",
        retry: { maxAttempts: 2, backoffMs: 0 },
        output: { name: "out", type: "note", format: "text" },
      }],
    }, agents).program!;
    const retryTrace: string[] = [];
    let sends = 0;
    const completed = await createRuntime(surface, {
      trace: retryTrace,
      capabilities: surface.capabilities,
      createSend: () => async () => {
        sends += 1;
        retryTrace.push("send:work");
        return sends === 1
          ? { code: "temporary", message: "temporary", retryable: true }
          : note("ok");
      },
    }).start(retrying);

    assert.equal(completed.status, "completed");
    assert.deepEqual(retryTrace, [
      "open:work",
      "send:work",
      "close:work",
      "open:work",
      "send:work",
      "close:work",
    ]);
    assert.equal(completed.snapshot.diagnostics[0]?.code, "temporary");
  });
}

interface HostSurfaceContract {
  name: string;
  slug: string;
  capabilities: PipelineAdapterPolicyCapabilities;
}

interface ContractRuntimeOptions {
  trace: string[];
  capabilities?: PipelineAdapterPolicyCapabilities;
  createSend: (input: AgentNodeSessionFactoryInput) => (input: Parameters<NonNullable<PipelineRuntimeAdapter["execute"]>>[0] & { replay?: boolean }) => Promise<PipelineNodeExecutionResult>;
  onActivity?: (handler: (activity: AgentNodeSessionActivity) => void) => () => void;
  onEvent?: (event: PipelineRuntimeEvent) => void;
}

function createRuntime(surface: HostSurfaceContract, options: ContractRuntimeOptions): PipelineRuntime {
  const store = new InMemoryPipelineRunStore();
  const adapter: PipelineRuntimeAdapter = {
    async createSession(input) {
      options.trace.push(`open:${input.node.id}`);
      const send = options.createSend(input);
      return {
        runId: input.runId,
        nodeId: input.node.id,
        onActivity: options.onActivity,
        async send(turn) {
          return send(turn);
        },
        async cancel() {
          options.trace.push(`cancel:${input.node.id}`);
        },
        async close() {
          options.trace.push(`close:${input.node.id}`);
        },
      };
    },
  };
  return new PipelineRuntime(adapter, {
    adapterName: surface.name,
    adapterCapabilities: options.capabilities ?? surface.capabilities,
    runIdFactory: () => `run-${surface.slug}`,
    now: () => new Date("2026-07-21T00:00:00.000Z"),
    store,
    onEvent: options.onEvent,
  });
}

function singleNodeProgram(id: string) {
  return compilePipelineV3Definition({
    version: 3,
    id,
    title: "Host Parity Single Node",
    nodes: [{
      id: "work",
      agent: "Codex",
      prompt: "work",
      output: { name: "out", type: "note", format: "text" },
    }],
  }, agents).program!;
}

function note(value: string): PipelineNodeExecutionResult {
  return { artifact: { name: "out", type: "note", format: "text", value } };
}

function agentPlan(value: string): PipelineNodeExecutionResult {
  return {
    artifact: {
      name: "plan",
      type: "acp.grill-decision/v1",
      format: "markdown",
      value,
    },
  };
}

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
