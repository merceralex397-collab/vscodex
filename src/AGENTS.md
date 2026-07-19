# Source guidelines

Keep the extension passive. VS Code owns all context, tools, MCP, execution, edits, and approvals. App-server owns only supported ChatGPT authentication, models, reasoning, streaming, threads, and usage.

Executable configuration must remain machine-scoped. Launch with `cross-spawn`, a sanitized environment, a neutral cwd, all passive flags before `app-server`, and a verified per-process/per-thread disabled MCP map.

Use minimal wire types in `appServer/wireTypes.ts`. Validate every required response field at the boundary, ignore unknown optional fields, and surface concrete method/params/shape incompatibilities with `CodexCompatibilityError`.

Never add direct backend/API-key/token paths or invoke VS Code tools from the provider. Emit tool calls and resume the suspended app-server request only after the caller returns the exact call-ID result.
