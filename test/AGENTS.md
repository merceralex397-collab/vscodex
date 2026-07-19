# Test guidelines

Tests must be deterministic unless explicitly named as real-runtime/manual tests. The fake app-server is the default integration boundary and must not use ambient credentials.

Cover minimum/newer/prerelease/malformed CLI versions; unknown optional and missing required fields; unsupported methods/params; passive-policy violations; MCP zero/multiple/mixed/punctuation/slow/malformed/changing/not-disabled cases; auth, model pagination, turns, tool handoff, cancellation, concurrency, usage, malformed JSONL, and crashes.

Extension-host tests must prove machine-scoped executable selection and one VS Code-owned tool loop. Public real-runtime CI may initialize and read signed-out account state, but must never import or require ChatGPT credentials.
