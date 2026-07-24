import * as assert from "node:assert/strict";
import { test } from "node:test";

import { renderAcpPrompt } from "../dist/index.js";

test("renderAcpPrompt preserves skills, instructions, and task as separate ACP text blocks", () => {
  const blocks = renderAcpPrompt(
    {
      skills: ["implement", "tdd"],
      instructions: "You are the implementation agent.",
      task: "Implement ticket T01.",
      context: [{
        name: "specification",
        type: "acp.specification/v1",
        format: "markdown",
        value: "Approved specification",
        producerNodeId: "spec",
      }],
    },
    {
      renderSkills: names => names.map(name => `<skill name="${name}">${name}</skill>`).join("\n"),
    },
  );

  assert.deepEqual(blocks, [
    {
      type: "text",
      text: '<skills>\n<skill name="implement">implement</skill>\n<skill name="tdd">tdd</skill>\n</skills>',
    },
    {
      type: "text",
      text: "<instructions>\nYou are the implementation agent.\n</instructions>",
    },
    {
      type: "text",
      text: "<task>\nImplement ticket T01.\n</task>",
    },
  ]);
});

test("renderAcpPrompt omits empty optional layers and always emits the task", () => {
  assert.deepEqual(
    renderAcpPrompt({ skills: [], task: "Review the diff.", context: [] }),
    [{ type: "text", text: "<task>\nReview the diff.\n</task>" }],
  );
});
