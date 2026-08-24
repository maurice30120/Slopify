# Replace Sandcastle with Docker Sandboxes

Slopify will remove Sandcastle completely and use Docker Sandboxes as its isolation runtime. The first migration supports Codex only; Pi and Vibe will be added later through `sbx`, without retaining a Sandcastle fallback. This phased scope avoids maintaining two isolation stacks while preserving room to validate the new runtime and promotion contract before integrating unsupported agents.
