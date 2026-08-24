# Keep ACP as the sandbox runtime boundary

The pipeline continues to communicate with isolated agents through ACP while a Docker Sandbox bridge owns the `sbx` subprocess lifecycle. Sandbox status, preview, promotion and rejection remain bridge extension operations under sandbox-neutral names. This keeps `acp-pipeline` independent from Docker’s evolving CLI and confines migration risk to the runtime and workspace integration layers.
