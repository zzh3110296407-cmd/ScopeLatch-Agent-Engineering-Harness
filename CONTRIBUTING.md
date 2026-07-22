# Contributing

Thank you for helping improve Agent Engineering Harness.

## Before You Start

1. Open an issue for behavior changes, new enforcement rules, or compatibility changes.
2. Keep pull requests focused and explain the repository risk being addressed.
3. Do not include credentials, private repository data, copied proprietary code, or machine-local paths.

## Development

Requirements are Node.js 24+, Python 3.11+, and Git. Docker is optional.

```bash
npm test
node harness/cli.mjs status
node harness/cli.mjs security --profile public-release
```

Changes to enforcement behavior should include tests for both allowed and denied paths. Changes to Hooks must preserve Python standard-library-only operation. Changes to configuration or commands must update both README files and relevant documents.

## Pull Requests

Include:

- the problem and intended behavior;
- files and enforcement boundaries changed;
- validation commands and results;
- security or compatibility impact;
- remaining limitations.

Do not weaken tests or security checks to obtain a passing result. If a check cannot run, state the exact command and reason.

By contributing, you agree that your contribution is licensed under Apache License 2.0.
