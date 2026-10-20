# Replace Sandcastle with Docker Sandboxes

> Une option Docker Engine est proposée pour le candidat Control Plane V2 dans l’[ADR 0018](0018-use-docker-engine-for-v2-workers.md). Son adoption dépend de l’évaluation du prototype d’architecture.

Slopify will remove Sandcastle completely and use Docker Sandboxes as its isolation runtime. The first migration supports Codex only; Pi will be added later through `sbx` for V2 (Vibe is out of scope). This phased scope avoids maintaining two isolation stacks while preserving room to validate the new runtime and promotion contract before integrating unsupported agents.
