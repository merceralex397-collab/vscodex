# Repository guidelines

CodexVS is a native VS Code `LanguageModelChatProvider`. VS Code and its calling Copilot agent own context, tools, MCP integrations, commands, edits, approvals, and permissions. The extension uses the official Codex app-server only for ChatGPT authentication, model discovery, reasoning, streaming, conversation state, and account limits.

## Invariants

- Do not add direct ChatGPT HTTP calls, OpenAI SDK transport, custom backend URLs, API-key authentication, token parsing, or credential-file access.
- Require stable Codex CLI 0.144.4 or newer. Reject prereleases by default, warn above the latest release-validated version, and fail progressively on concrete incompatible operations.
- Keep app-server in an extension-controlled empty cwd with no workspace/capability roots.
- Keep `CODEX_HOME` for shared official login, but remove API-key/access-token environment variables from the child.
- Disable every Codex built-in capability. Only caller-supplied `item/tool/call` may cross the boundary, and VS Code executes it.
- Never expose Codex-configured MCP servers. Use the redacted plain-text enumeration strategy to prove process-local disabling without changing global configuration or requesting JSON output.
- Keep minimal internal wire types plus strict validators for required fields. Ignore unknown optional fields and notifications.
- Keep the source code under the repository's MIT License. Generate and ship required bundled dependency notices separately.

## Structure

- `src/extension.ts`: activation, commands, provider composition.
- `src/config.ts`: machine-safe configuration.
- `src/provider.ts`: VS Code provider surface.
- `src/appServer/`: process, auth, models, turns, tool bridge, usage, MCP isolation, and wire boundaries.
- `test/fixtures/`: deterministic fake app-server.
- `docs/ARCHITECTURE.md`: current design and trust boundary.
- `docs/DEVELOPMENT.md`: development, compatibility, packaging, and release.

## Commands

- `npm run check`
- `npm run compile`
- `npm run check:notices`
- `npm run check:security`
- `npm run test:unit`
- `npm run test:smoke`
- `npm run test:extension-host`
- `npm run test:app-server`
- `npm run test:real-app-server`
- `npm run package:vsix -- --pre-release`
- `npm run check:package`

Use TypeScript with two-space indentation, semicolons, single quotes, explicit domain types, and small focused modules. Use `apply_patch` for handwritten edits. Never commit credentials, VSIX artifacts, runtime state, or private logs.

Release `0.2.1` as Marketplace pre-release `v0.2.1-pre`. The package identity is `merceralex397-collab.codexvs`, command/settings namespace is `codexvs`, provider vendor is `codexvs`, and app-server client name is `codexvs`.
