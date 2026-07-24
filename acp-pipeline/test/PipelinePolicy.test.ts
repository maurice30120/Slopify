import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  NATIVE_ACP_BASELINE_CAPABILITIES,
  SANDCASTLE_BASELINE_CAPABILITIES,
  evaluateToolPermissionForPolicy,
  mapPolicyToLegacyPermissions,
  mapPolicyToLegacySideEffects,
  normalizePipelinePolicy,
  validateAdapterSupportsPolicy,
} from "../dist/index.js";

test("normalizePipelinePolicy applies read-only defaults deterministically", () => {
  assert.deepEqual(normalizePipelinePolicy(undefined), {
    filesystem: "read-only",
    terminal: "none",
    network: "disabled",
    promotion: "discard",
  });
});

test("validateAdapterSupportsPolicy refuses policies an adapter cannot guarantee", () => {
  const policy = normalizePipelinePolicy({
    filesystem: "read-only",
    terminal: "none",
    network: "enabled",
    promotion: "ask",
  });

  assert.deepEqual(validateAdapterSupportsPolicy("native ACP", NATIVE_ACP_BASELINE_CAPABILITIES, policy), [
    {
      code: "unsupported_policy",
      field: "network",
      message: 'native ACP adapter cannot guarantee network policy "enabled".',
    },
    {
      code: "unsupported_policy",
      field: "promotion",
      message: 'native ACP adapter cannot guarantee promotion policy "ask".',
    },
  ]);
  assert.deepEqual(validateAdapterSupportsPolicy("Sandcastle", SANDCASTLE_BASELINE_CAPABILITIES, policy), []);
});

test("evaluateToolPermissionForPolicy denies mutations under read-only policy", () => {
  const readonly = normalizePipelinePolicy(undefined);
  assert.equal(evaluateToolPermissionForPolicy(readonly, "read"), null);
  assert.equal(evaluateToolPermissionForPolicy(readonly, "search"), null);
  assert.equal(evaluateToolPermissionForPolicy(readonly, "edit")?.field, "filesystem");
  assert.equal(evaluateToolPermissionForPolicy(readonly, "delete")?.field, "filesystem");
  assert.equal(evaluateToolPermissionForPolicy(readonly, "move")?.field, "filesystem");
  assert.equal(evaluateToolPermissionForPolicy(readonly, "execute")?.field, "terminal");
  assert.equal(evaluateToolPermissionForPolicy(readonly, "fetch")?.field, "network");
});

test("legacy mappings preserve existing adapter vocabulary", () => {
  const readonly = normalizePipelinePolicy(undefined);
  const write = normalizePipelinePolicy({ filesystem: "workspace-write", terminal: "workspace-write" });

  assert.equal(mapPolicyToLegacySideEffects(readonly), "none");
  assert.equal(mapPolicyToLegacyPermissions(readonly), "ask");
  assert.equal(mapPolicyToLegacySideEffects(write), "workspace");
  assert.equal(mapPolicyToLegacyPermissions(write), "ask");
});
