import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  compileExecutionPlan,
  markExecutionPlanExpanded,
  publishMultiAgentArtifact,
  validateExecutionPlan,
  validateMultiAgentArtifact,
} from "../dist/index.js";

test("validateMultiAgentArtifact accepts versioned ticket graph artifacts", () => {
  const result = validateMultiAgentArtifact("acp.ticket-graph/v1", {
    contract: "acp.ticket-graph/v1",
    tickets: [
      {
        id: "T01",
        title: "Build runtime",
        scope: ["acp-pipeline/**"],
        needs: [],
        validation: ["npm test"],
      },
    ],
  });

  assert.equal(result.ok, true);
});

test("validateMultiAgentArtifact reports localized contract and field errors", () => {
  const unknown = validateMultiAgentArtifact("acp.unknown/v9", {});
  assert.deepEqual(unknown.errors, ['Unknown artifact contract "acp.unknown/v9".']);

  const invalid = validateMultiAgentArtifact("acp.verification-report/v1", {
    contract: "acp.verification-report/v1",
    verdict: "maybe",
    categories: [{ name: "", required: "yes", status: "bad", details: "" }],
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /verdict/);
  assert.match(invalid.errors.join("\n"), /categories\[0\]\.required/);
  assert.match(invalid.errors.join("\n"), /categories\[0\]\.status/);
});

test("publishMultiAgentArtifact returns a typed PipelineArtifact", () => {
  const result = publishMultiAgentArtifact("verify", "report", "acp.verification-report/v1", {
    contract: "acp.verification-report/v1",
    verdict: "passed",
    categories: [{ name: "tests", required: true, status: "passed", details: "ok" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.value?.producerNodeId, "verify");
  assert.equal(result.value?.name, "report");
  assert.equal(result.value?.type, "acp.verification-report/v1");
  assert.equal(result.value?.format, "json");
});

test("compileExecutionPlan derives stable implementation identities, terminals, and final review", () => {
  const result = compileExecutionPlan({
    contract: "acp.ticket-graph/v1",
    tickets: [
      { id: "T01", title: "Core", scope: ["core/**"], needs: [], validation: ["test core"] },
      { id: "T02", title: "API", scope: ["api/**"], needs: ["T01"], validation: ["test api"] },
      { id: "T03", title: "Docs", scope: ["docs/**"], needs: ["T01"], validation: ["test docs"] },
    ],
  });

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.plan?.nodes.map(node => node.id), ["T01", "T02", "T03"]);
  assert.deepEqual(result.plan?.terminalNodeIds, ["T02", "T03"]);
  assert.deepEqual(result.plan?.finalReview, {
    id: "final-review",
    kind: "final-review",
    needs: ["T02", "T03"],
  });
  assert.equal(Object.isFrozen(result.plan), true);
  assert.equal(Object.isFrozen(result.plan?.nodes[0]), true);
});

test("compileExecutionPlan rejects duplicate identities, missing dependencies, and cycles", () => {
  const duplicate = compileExecutionPlan({
    contract: "acp.ticket-graph/v1",
    tickets: [
      { id: "T01", title: "One", scope: [], needs: [], validation: [] },
      { id: "T01", title: "Two", scope: [], needs: [], validation: [] },
    ],
  });
  assert.match(duplicate.errors.join("\n"), /T01.*duplicated/i);

  const invalidGraph = compileExecutionPlan({
    contract: "acp.ticket-graph/v1",
    tickets: [
      { id: "T01", title: "One", scope: [], needs: ["missing"], validation: [] },
      { id: "T02", title: "Two", scope: [], needs: ["T02"], validation: [] },
    ],
  });
  assert.match(invalidGraph.errors.join("\n"), /T01.*unknown.*missing/i);
  assert.match(invalidGraph.errors.join("\n"), /cycle.*T02/i);
});

test("validateExecutionPlan rejects unsupported versions and invalid final review dependencies", () => {
  const unsupported = validateExecutionPlan({ contract: "acp.execution-plan/v2" });
  assert.deepEqual(unsupported.errors, ['Unsupported Execution Plan contract "acp.execution-plan/v2".']);

  const compiled = compileExecutionPlan({
    contract: "acp.ticket-graph/v1",
    tickets: [{ id: "T01", title: "One", scope: [], needs: [], validation: [] }],
  }).plan!;
  const invalid = validateExecutionPlan({
    ...compiled,
    finalReview: { ...compiled.finalReview, needs: [] },
  });
  assert.match(invalid.errors.join("\n"), /finalReview\.needs.*terminal/i);

  const collision = compileExecutionPlan({
    contract: "acp.ticket-graph/v1",
    tickets: [{ id: "final-review", title: "Collision", scope: [], needs: [], validation: [] }],
  });
  assert.match(collision.errors.join("\n"), /final-review.*reserved/i);
});

test("markExecutionPlanExpanded records one complete expansion and rejects a second copy", () => {
  const plan = compileExecutionPlan({
    contract: "acp.ticket-graph/v1",
    tickets: [{ id: "T01", title: "One", scope: [], needs: [], validation: [] }],
  }).plan!;
  const pending = { plan, expansion: { status: "pending" as const, expandedNodeIds: [] } };

  const expanded = markExecutionPlanExpanded(pending, ["T01", "final-review"], "2026-08-24T12:00:00.000Z");
  assert.equal(expanded.expansion.status, "expanded");
  assert.deepEqual(expanded.expansion.expandedNodeIds, ["T01", "final-review"]);
  assert.throws(
    () => markExecutionPlanExpanded(expanded, ["T01", "final-review"], "2026-08-24T12:01:00.000Z"),
    /already expanded/i,
  );
  assert.throws(
    () => markExecutionPlanExpanded(pending, ["T01"], "2026-08-24T12:00:00.000Z"),
    /exactly once/i,
  );
});
