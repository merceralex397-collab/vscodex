# Contributing to CodexVS

Thanks for helping improve CodexVS.

## Before opening an issue

- Search existing issues first.
- Use the bug or feature-request form.
- Remove credentials, prompts, tool data, private paths, and private logs.
- Use a minimal reproduction with the fake app-server whenever possible.
- Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development

1. Fork the repository and create a focused branch.
2. Install dependencies with `npm ci`.
3. Make a small, documented change that preserves the trust boundary in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
4. Add or update deterministic tests.
5. Run the verification commands in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
6. Open a pull request using the repository template.

Use TypeScript with two-space indentation, semicolons, single quotes, explicit domain types, and small focused modules.

## License

By submitting a contribution, you agree that it is your original work and that it may be distributed under the repository's [MIT License](LICENSE).
