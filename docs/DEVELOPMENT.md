# Development and release

## Local workflow

Install dependencies with `npm install`. Use `npm run check` for TypeScript, `npm run compile` for the extension bundle, and the unit/smoke/extension-host suites for behavior. `npm run check:security` enforces product invariants and `npm run check:notices` verifies generated third-party notices.

Press `F5` to run the Extension Development Host. Deterministic development should use the fake app-server. Use `npm run test:real-app-server` only for explicit live-account validation.

For a live Copilot validation, configure `chat.utilityModel` and `chat.utilitySmallModel` first. Exercise ordinary file search/read, an edit under normal VS Code approval rules, a terminal or task call, and the native VS Code subagent tool. A successful native subagent call must cross `item/tool/call`; any Codex `collabToolCall` or `collabAgentToolCall` is a passive-policy failure.

Also exercise the model picker's **Thinking Effort** control on a host that supports provider configuration metadata. Confirm catalog order, **Max**, **Ultra (VS Code)**, and any unknown test identifier are represented correctly. Select Ultra on a model that advertises both Max and Ultra, give it a complex task without explicitly asking for delegation, and confirm:

1. The privacy-safe request-shape record reports requested mode `ultra`, backend effort `max`, orchestration mode `vscodeProactive`, and VS Code delegation available.
2. A native collapsible subagent call appears and its tool activity and credits are inspectable in VS Code.
3. No `collabToolCall` or `collabAgentToolCall` occurs.
4. A nested worker with `runSubagent` omitted completes as standard single-agent Max.
5. Only one proactive subagent call is outstanding at a time.

On the oldest supported VS Code host, confirm **Codex: Configure Reasoning Effort** builds choices from the live catalog, updates the fallback, and does not require provider configuration UI. Also confirm that an unsupported saved identifier falls back to the selected model's catalog default.

Use **Codex: Show Integration Diagnostics** to capture structural evidence without prompt content. For deeper caller failures, inspect the GitHub Copilot Chat log under the current VS Code logs folder. For app-server failures, use the lifecycle metadata first. Local Codex stores under `CODEX_HOME` and raw stderr may contain private prompts or tool data and must never be copied into fixtures, issues, commits, or VSIX artifacts.

Codex CLI 0.144.4 can emit `Model personality requested but model_messages is missing` for catalog entries even when the effective personality is the official `none` value. The CLI then falls back to the same base instructions. Treat this specific `personality=none` warning as upstream diagnostic noise; any other effective personality is a passive-policy defect.

## Compatibility changes

Protocol changes require minimal wire-type updates and runtime validators for required fields. Do not add a full generated protocol tree. Keep unknown optional fields forward-compatible. Every newly required RPC should identify method-not-found, invalid-params, and malformed required responses through `CodexCompatibilityError`.

Production installation guidance always uses `@openai/codex@latest`; documentation states the minimum supported stable version separately. CI exercises both the minimum and latest stable releases.

## Packaging

The manifest version is numeric because Marketplace manifests do not use a SemVer suffix. Build the first pre-release with:

```powershell
npm run package:vsix -- --pre-release
```

The expected artifact is `codexvs-0.2.1-pre-release.vsix`. Package inspection checks identity, forbidden capabilities and credentials, the MIT license, bundled dependency notices, and the exact package allowlist.

## Release

The clean repository begins with one root commit on `main`. The pre-release tag is `v0.2.1-pre`. The release workflow validates the minimum and latest Codex CLI, builds the VSIX, generates its SHA-256 checksum, and creates the GitHub pre-release. Upload that exact verified VSIX manually to the Marketplace publisher `merceralex397-collab`; no Marketplace credential is stored in GitHub.

Before tagging, validate a fresh isolated-profile install, local and remote login paths, model discovery, streaming, one VS Code-owned tool loop, cancellation, concurrency, account limits, crash recovery, and configured-MCP isolation.

The live VS Code checklist also includes:

1. Both utility settings resolve without a `copilot-utility-small` error.
2. The native Thinking Effort choice reaches the request; Max remains single-agent, Ultra maps to backend Max plus governed VS Code orchestration, and the global fallback works when the native control is unavailable.
3. The request-shape diagnostic shows more than the visible final user text when Copilot supplied instructions, context, or history.
4. Search tools can inspect the repository; no literal `@codebase` function is expected.
5. The model does not infer that VS Code is read-only from the passive backend sandbox.
6. The caller's native subagent tool runs and returns through the dynamic bridge, while nested-tool omission falls back without recursion or failure.
7. Screenshots or other binary results do not get copied into extension logs.

Primary contracts: [VS Code provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider), [VS Code tools API](https://code.visualstudio.com/api/extension-guides/ai/tools), [VS Code subagents](https://code.visualstudio.com/docs/agents/subagents), [VS Code utility models](https://code.visualstudio.com/docs/agent-customization/language-models#_change-the-model-for-utility-tasks), and [Codex app-server](https://developers.openai.com/codex/app-server/).
