## Summary

Describe the change and why it is needed.

## Trust-boundary impact

Explain whether this changes authentication, child-process isolation, MCP handling, tool execution, workspace access, logging, or packaging. Write “None” when it does not.

## Verification

- [ ] `npm run check`
- [ ] `npm run compile`
- [ ] `npm run check:notices`
- [ ] `npm run check:security`
- [ ] Relevant unit, smoke, extension-host, and app-server tests
- [ ] No credentials, prompts, tool data, private paths, logs, or VSIX artifacts are included

## Checklist

- [ ] Documentation and changelog are updated when behavior changes
- [ ] New behavior has deterministic coverage
- [ ] The change is licensed for distribution under MIT
