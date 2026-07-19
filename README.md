# vsCodex

[![CI](https://github.com/merceralex397-collab/vscodex/actions/workflows/ci.yml/badge.svg)](https://github.com/merceralex397-collab/vscodex/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

vsCodex is a native VS Code `LanguageModelChatProvider` backed by the official Codex app-server. It lets VS Code and GitHub Copilot use your shared ChatGPT Codex account for model discovery, reasoning, streaming responses, conversation state, and account limits.

VS Code and the calling Copilot agent remain the sole owners of context selection, tools, MCP integrations, command execution, edits, approvals, and permissions. vsCodex never exposes tools configured in Codex itself.

## Requirements

- VS Code 1.104.0 or newer.
- A stable Codex CLI version 0.144.4 or newer on the machine where the extension host runs.
- A ChatGPT account supported by Codex CLI authentication.

Install or update Codex CLI:

```powershell
npm install -g @openai/codex@latest
codex --version
```

Remote SSH, WSL, and dev-container extension hosts need their own Codex CLI installation. If `codex` is not on that host's `PATH`, run **Codex: Configure Codex Executable**. The setting is machine-scoped so a workspace cannot replace the executable.

## Installation

Install the pre-release from the VS Code Marketplace once it is published, or download the VSIX and matching SHA-256 file from the [v0.2.1 pre-release](https://github.com/merceralex397-collab/vscodex/releases/tag/v0.2.1-pre).

```powershell
code --install-extension vscodex-0.2.1-pre-release.vsix --force
```

The Marketplace package is uploaded manually from the same verified VSIX attached to the GitHub pre-release.

## Development install

```powershell
npm install
npm run compile
```

Open this folder in VS Code, press `F5`, and select **Run vsCodex Extension**. In the Extension Development Host:

1. Open Chat and select a model supplied by `vsCodex`.
2. Run **Codex: Sign in with ChatGPT** if prompted.
3. Use **Codex: Sign in with Device Code** when browser login cannot return to the extension host.
4. Run **Codex: Check App-server Runtime** for executable, version, or MCP-isolation diagnostics.
5. Choose **Thinking Effort** beside the model picker, or run **Codex: Configure Reasoning Effort** for the global fallback.
6. Run **Codex: Configure VS Code Utility Models** and choose a general and a small model.
7. Run **Codex: Show Integration Diagnostics** to verify the runtime, discovered models, registered VS Code tools, utility settings, and workspace trust.

To install the packaged pre-release:

```powershell
npm run package:vsix -- --pre-release
code --install-extension vscodex-0.2.1-pre-release.vsix --force
```

Use a separate profile for a truly isolated install:

```powershell
code --user-data-dir .tmp/vscode-profile --extensions-dir .tmp/vscode-extensions --install-extension vscodex-0.2.1-pre-release.vsix
```

## Authentication

Codex app-server owns ChatGPT authentication. vsCodex preserves the normal `CODEX_HOME`, so a supported login is shared with Codex CLI and other Codex clients. It never reads or logs credential files or tokens, and it removes API-key/access-token environment variables from the passive child process.

Signing out removes the shared Codex login and therefore requires confirmation.

## MCP and tools

Codex CLI clients share MCP configuration. vsCodex does not modify that global configuration and does not make those servers available to Copilot. Before starting its passive app-server child it:

1. Reads only the redacted plain-text `codex mcp list` output.
2. Retains bounded server names, transport types, and enabled status.
3. Creates exact process-local `enabled=false` overrides with harmless replacement transports.
4. lists again and proves the same server set is disabled.
5. passes the verified disabled map into every thread.

Each listing has an independent 30-second timeout. App-server startup retains its separate 10-second timeout. A timeout, malformed listing, changing server set, or failure to disable is reported distinctly. Valid global MCP servers do not need to be removed.

Caller-supplied VS Code tools are different: vsCodex reports a dynamic tool call to VS Code, the caller executes it under VS Code permissions, and the result is returned on a later provider invocation. Every Codex-owned command, filesystem, MCP, web, browser, computer, image, plugin, hook, skill, memory, goal, or subagent path is disabled and rejected.

Caller tools receive deterministic `vscode_` aliases and descriptions that identify them as VS Code-executed. This matters for tools such as the native VS Code subagent tool: Codex must call the supplied VS Code tool and must never use its own `spawn_agent` route. The current stable Codex CLI can still attempt an internal collaboration call after multi-agent features are disabled, so vsCodex also rejects both known collaboration event shapes as invariant violations.

`Ultra (VS Code)` uses that same caller-owned path. It does not expose a Codex subagent or broaden backend permissions. The native subagent remains visible as a collapsible VS Code tool call, and VS Code remains responsible for its activity, approvals, and credit reporting.

`@codebase` is a VS Code chat mention and context-selection route, not a required callable tool named `codebase`. Codebase access is working when the calling agent supplies and successfully executes its search, file, symbol, or semantic-search tools. Some semantic search and embedding features still require the GitHub Copilot service; a model provider cannot supply those services by itself.

## VS Code utility models

VS Code uses separate models for background work such as titles, summaries, intent detection, branch names, and commit messages. When the main agent uses a BYOK or extension-provided model and built-in Copilot utility models are unavailable, both `chat.utilityModel` and `chat.utilitySmallModel` must point to an available model. Otherwise VS Code reports errors such as `No utility model is configured for 'copilot-utility-small'` before the main model can help.

Run **Codex: Configure VS Code Utility Models** to set both global settings. The command lets you choose a capable general model and a faster small model. This follows the official [VS Code utility-model guidance](https://code.visualstudio.com/docs/agent-customization/language-models#_change-the-model-for-utility-tasks).

## Thinking effort

Each discovered model advertises only the reasoning modes supported by its Codex catalog entry, in catalog order. Known modes receive friendly labels; an unknown future identifier is shown verbatim instead of being discarded. On VS Code 1.128 and newer, choose **Thinking Effort** beside the model picker to change it for that model in the current chat. The native choice is passed to vsCodex as model configuration and takes precedence over every default.

Run **Codex: Configure Reasoning Effort** from the Command Palette or **Codex: Manage** for a global default built from the live model catalog. This is also the control for older supported VS Code versions, where provider configuration controls are not rendered. **Auto (model default)** follows the catalog; an unsupported global choice is ignored for that model instead of being sent to app-server.

**Max** is maximum single-agent reasoning. **Ultra (VS Code)** appears only when the same model advertises both `max` and `ultra`. vsCodex never sends raw `ultra` to app-server: it sends `max` and, when the actual request includes VS Code's native `runSubagent` or `agent/runSubagent` tool, adds proactive instructions naming that tool's exact `vscode_*` alias.

If the native tool is absent, Ultra completes as single-agent Max instead of failing. This is also the expected fallback inside a VS Code subagent when nested invocation is disabled; nested delegation occurs only when VS Code itself supplies the tool under `chat.subagents.allowInvocationsFromSubagents`. Version 1 deliberately issues at most one delegated call at a time because Codex 0.144.4 advertises caller-supplied dynamic tools as non-parallel.

Greater effort generally spends more reasoning tokens and takes longer. Ultra can additionally consume VS Code subagent credits and the delegated worker's tokens, so it should be reserved for work that benefits materially from an isolated investigation. The request-shape log records the requested mode, backend effort, orchestration mode, and whether VS Code delegation was available without recording prompt content. See the official [Codex configuration reference](https://developers.openai.com/codex/config-reference/#model-reasoning-effort), [VS Code model-picker guidance](https://code.visualstudio.com/docs/agent-customization/language-models#_change-the-language-model-for-chat), and [VS Code subagent guidance](https://code.visualstudio.com/docs/agents/subagents).

## Prompt and context behavior

VS Code's Language Model API has user and assistant message roles; it does not expose a separate system-message role to providers. Copilot assembles its agent instructions, repository instructions, selected context, conversation history, tool calls, and tool results into the request it sends to vsCodex. The short text visible in the chat input is therefore not the whole model input.

vsCodex deliberately replaces Codex's normal agent base instructions with a small passive-provider contract, adds `vsCodex.instructions` as developer instructions, and converts the complete VS Code message list into app-server input. It suppresses Codex's own environment, permission, and collaboration-mode prompt blocks because those describe the isolated backend rather than the VS Code caller. See the official [Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model) and [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider).

Every model request records a privacy-safe request shape in the vsCodex output: message counts, role counts, part counts, text-character count, tool-definition count, tool mode, requested reasoning mode, backend effort, orchestration mode, and VS Code delegation availability. **Codex: Show Integration Diagnostics** adds runtime, model, tool-registration, reasoning-default, utility-setting, workspace-trust, and extension-host state. Neither record includes prompt text, tool names, tool arguments, tool results, credentials, or raw app-server stderr.

## Diagnostics and logs

- **Codex: Open Debug Logs** opens the `vsCodex` log output. Lifecycle records include runtime version, RPC method, duration, generation, and app-server stderr byte/line counts only.
- Run **Developer: Open Logs Folder** for VS Code and GitHub Copilot Chat logs. Copilot-side utility-model, tool-schema, and context-ingestion failures appear there rather than in app-server output.
- Codex uses the normal `CODEX_HOME` (normally `%USERPROFILE%\.codex`). Codex CLI 0.144.4 maintains bounded diagnostic data in files such as `logs_2.sqlite`; the app-server itself writes diagnostics to stderr. These stores can contain prompts and tool data, are private, and are not a stable integration API. vsCodex never reads or packages them.
- The repository ignores `logs/`, `*.log`, and packaged log paths so captured private diagnostics cannot enter source control or a VSIX by accident.

The app-server remains the right official integration surface: it supplies ChatGPT authentication, model discovery, threads, turns, streaming, usage, and caller-executed dynamic tools without adding a private HTTP transport. See the official [Codex app-server documentation](https://developers.openai.com/codex/app-server/).

## Compatibility policy

vsCodex accepts parseable stable Codex CLI releases from 0.144.4 onward. Older, malformed, and prerelease versions fail before launch. A CLI newer than the latest version validated for a given extension release produces a non-blocking warning.

Compatibility is then checked progressively at the operation being used: initialization, authentication, model discovery, thread creation/fork/injection, turns, account limits, and dynamic tools. Unknown optional response fields and notifications are ignored. Missing required fields, method-not-found, and invalid-params failures produce a `CodexCompatibilityError` containing the safe CLI version, operation, and failure category.

## Settings

- `vsCodex.appServer.command`: machine-scoped Codex executable; defaults to `codex`.
- `vsCodex.instructions`: developer instructions added to passive threads.
- `vsCodex.model`: preferred discovered model.
- `vsCodex.disabledModels`: discovered model IDs to hide.
- `vsCodex.modelAliases`: obsolete-to-current model aliases.
- `vsCodex.defaultReasoningEffort`: `auto` or a live catalog reasoning identifier; the native per-chat control wins.
- `vsCodex.defaultServiceTier`: preferred advertised service tier.

VS Code's `chat.utilityModel` and `chat.utilitySmallModel` are global editor settings, not vsCodex settings. Use **Codex: Configure VS Code Utility Models** to set them.

## Verification

```powershell
npm run check
npm run compile
npm run check:notices
npm run check:security
npm run test:unit
npm run test:smoke
npm run test:extension-host
npm run test:app-server
npm run test:real-app-server
npm run package:vsix -- --pre-release
npm run check:package
```

The real-account suite is opt-in and uses the existing shared ChatGPT login. Public CI never stores or imports that login.

## Ownership and licensing

Copyright © 2026 merceralex397-collab.

vsCodex is released under the [MIT License](LICENSE). Bundled third-party software remains under its own terms; required notices are shipped in `THIRD_PARTY_NOTICES.md`.

Questions and reproducible bug reports belong in [GitHub Issues](https://github.com/merceralex397-collab/vscodex/issues). Please read [Support](SUPPORT.md), [Contributing](CONTRIBUTING.md), and [Security](SECURITY.md) before filing.

See [Architecture](docs/ARCHITECTURE.md) and [Development](docs/DEVELOPMENT.md) for implementation details.
