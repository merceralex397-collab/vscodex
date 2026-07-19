# Changelog

## 0.2.1 - 2026-07-19

### Reasoning controls

- Added a native per-chat **Thinking Effort** selector populated from each model's app-server catalog entry.
- Added **Codex: Configure Reasoning Effort** as a global fallback and an older-VS-Code compatibility path.
- Added catalog-driven **Max** and **Ultra (VS Code)** modes, including forward-compatible unknown identifiers.
- Mapped Ultra to backend Max plus proactive, serialized use of VS Code's native subagent tool, with single-agent Max fallback when the tool is absent.
- Added requested mode, backend effort, orchestration mode, and VS Code delegation availability to privacy-safe structural request diagnostics.

### VS Code integration

- Added guided configuration for both VS Code utility models to prevent BYOK utility-tool failures.
- Added integration diagnostics for runtime, models, tools, utility settings, reasoning defaults, trust, and extension-host location.
- Strengthened the passive boundary so VS Code remains the sole executor of caller tools, including its native subagent path.

### Security and reliability

- Hardened app-server process isolation, dynamic-tool validation, raw-Ultra rejection, collaboration-event rejection, multi-agent hint suppression, and Codex-side concurrency containment.
- Fixed early app-server event handling when a policy violation terminates a turn before `turn/start` responds.
- Fixed per-request reasoning selection on current stable VS Code by giving caller `modelOptions` precedence over the model-configuration default.
- Expanded deterministic, extension-host, app-server lifecycle, real-account, package-security, and privacy regression coverage.
- Excluded private logs and local investigation artifacts from source control and packaged releases.

### Release hygiene

- Released the source under the MIT License and added public contribution guidance.
- Restricted the VSIX to its runtime bundle, manifest, icon, documentation, license, and bundled dependency notices.
- Added checksum publication and kept Marketplace upload as an explicit manual release step.
