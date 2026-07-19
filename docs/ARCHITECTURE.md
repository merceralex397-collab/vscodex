# vsCodex architecture

vsCodex is a passive adapter between VS Code's stable Language Model API and the official Codex app-server JSONL protocol.

```text
VS Code / Copilot
  owns context, tools, MCP, edits, commands, approvals
        |
        | LanguageModelChatProvider
        v
vsCodex
  converts history, streams output, bridges dynamic tool requests
        |
        | JSON-RPC over stdio in a neutral directory
        v
Codex app-server
  owns ChatGPT auth, model discovery, reasoning and thread state
```

## Trust boundary

The app-server child receives no workspace cwd or capability root. It runs in an extension-controlled empty directory with a sanitized environment. API-key and access-token variables are removed; the normal `CODEX_HOME` remains so official ChatGPT authentication is shared without the extension reading credentials.

All Codex built-in capabilities are disabled before `app-server --stdio`. Every server-initiated request except `item/tool/call` is declined. Built-in execution, filesystem, MCP, browser, web, computer, image, plugin, skill, memory, goal, hook, and multi-agent events are invariant violations that interrupt the affected turn.

The process and each thread disable both stable and v2 multi-agent features. The v2 configuration also blanks root, subagent, and shared multi-agent usage hints, supplies a custom mode hint that prohibits Codex collaboration, and caps unexpected Codex-side concurrency at one. The passive thread disables Codex-generated environment, permission, and collaboration-mode prompt blocks, while retaining the actual empty cwd, read-only sandbox, and `never` approval policy as defense in depth. This prevents backend isolation metadata from being mistaken for the caller's VS Code permissions. Personality is explicitly set to the protocol's `none` value so a user or catalog default cannot replace the passive base contract.

VS Code tool definitions become deterministic `vscode_` app-server dynamic-tool aliases. Their descriptions retain the original caller name and explicitly identify VS Code as the executor and permission owner. The app-server request remains suspended while vsCodex emits a `LanguageModelToolCallPart`. VS Code executes the original tool; a later provider invocation supplies the exact call-ID result. Multiple calls use FIFO handoff and a ten-minute timeout, but proactive Ultra delegation is serialized to one call at a time because the minimum supported Codex dynamic-tool handler does not advertise parallel execution.

For `Ultra (VS Code)`, the provider detects only exact `runSubagent` and `agent/runSubagent` names in the current request's tool list. It resolves the request into the catalog mode, backend effort, and orchestration mode. Ultra always becomes backend `max`; when the native tool is present, developer instructions added after alias construction name its exact alias and encourage bounded, materially useful delegation. Without it, the orchestration mode is standard and the request remains single-agent Max. This lets nested workers respect VS Code's own nested-subagent control.

Codex collaboration item variants are rejected even if an upstream release exposes them despite disabled feature flags, and a backend request containing raw `ultra` is rejected before an RPC. These controls substantially contain upstream model-metadata overrides. An absolute guarantee that a built-in collaboration implementation can never begin before its lifecycle event is observed still requires app-server support for hiding those tools before model execution.

## Runtime lifecycle

One app-server process is launched lazily per extension host. Executable selection is machine-scoped. Runtime validation accepts stable semantic versions at or above 0.144.4 and warns when the version is newer than the extension release's validated maximum.

Startup validates `initialize` and acknowledges `initialized`. Other protocol surfaces are validated when first used. Required method-not-found, invalid-params, and malformed response failures become structured compatibility errors. Unknown optional fields and unknown notifications remain forward-compatible.

The extension uses small handwritten wire types only for values it sends or consumes. Runtime checks—not a checked-in version-specific generated schema—define the safety boundary.

Model metadata reserves 8,192 tokens for output and advertises the remainder as input capacity, so the two values sum to the app-server's discovered context window as VS Code requires. It also supplies a bounded `configurationSchema` for catalog-supported reasoning modes. Order and descriptions come from the catalog; known identifiers receive friendly labels and unknown identifiers remain visible. `ultra` is exposed as `Ultra (VS Code)` only when the same entry advertises `max`. Current VS Code renders that navigation-group property as the native **Thinking Effort** control and returns the selection in `modelConfiguration`; older supported hosts ignore the optional metadata and use the live-catalog global command/setting fallback.

Crashes invalidate the process generation, authentication state, models, account limits, and conversation branches. The next operation launches a fresh process. A turn is never replayed after visible text or a tool call.

Lifecycle and request diagnostics are structural. App-server stderr is consumed to prevent child-process blocking, but only cumulative byte and newline counts enter the extension log. Prompt text, tool names, schemas, arguments, results, stderr content, and credentials are excluded.

## MCP isolation

Codex clients share MCP configuration through the normal Codex home. A process-local isolation strategy enumerates the redacted plain-text list, builds exact quoted-key disabled overrides, proves the same set is disabled, and supplies the same map at thread creation. The strategy never writes global configuration or requests credential-bearing JSON output.

Enumeration is behind `McpIsolationStrategy`; a future documented app-server-wide disable mechanism can replace it without changing process or thread code.

## Conversations

Threads are ephemeral and read-only. Reuse requires append-only projected history and an identical envelope: process/account generations, runtime and passive-policy versions, model options, requested reasoning mode, backend effort, orchestration mode, instructions, tool mode, and canonical tool schemas. Max and Ultra therefore cannot share a thread even though Ultra sends backend Max.

Branches fork only from completed checkpoints. The known minimum-runtime `no rollout found` response for an ephemeral source cold-reconstructs the branch; other failures surface normally. Branches have a maximum count and idle TTL.

VS Code supplies only user and assistant message roles through the Language Model API. Copilot's assembled instructions and selected context are therefore carried inside that message history, while vsCodex supplies the app-server base and developer instruction fields separately. The visible chat input is not treated as the complete request.

## Authentication and discovery

Silent account discovery uses token-free `getAuthStatus` and `account/read`. Only ChatGPT auth is accepted. Browser login is preferred locally and device code remotely. Model discovery pages through `model/list` without fabricating fallbacks. Account limits use rate-limit reads and authoritative sparse notifications.
