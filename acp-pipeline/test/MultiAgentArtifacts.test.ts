import * as assert from "node:assert/strict";
import { test } from "node:test";

import { publishMultiAgentArtifact, validateMultiAgentArtifact } from "../dist/index.js";

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
