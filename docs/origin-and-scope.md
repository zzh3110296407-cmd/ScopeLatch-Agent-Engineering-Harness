# Origin and Scope

Agent Engineering Harness was created while building Multiple Agent For Stories, a large multi-agent narrative application with backend, frontend, storage, model-runtime, analysis, and continuity subsystems. The repository's size, historical source versions, cross-module contracts, and AI-assisted development exposed recurring engineering failures that simple prompt templates could not control.

The open-source package contains the independently useful control plane:

- repository indexing and context ranking;
- impact and synchronization analysis;
- validation planning;
- task/session/branch/commit/scope-bound leases;
- Codex Hook policies;
- Guard, repair, reporting, security, performance, and sandbox modules;
- Harness tests and public documentation.

It intentionally excludes the original application's source code, business data, prompts, runtime reports, failure history, credentials, local paths, and private project documentation.

The bilingual parser and synchronization catalogue retain some narrative-domain terminology because that domain supplied real validation pressure. Those terms are logic, not copied project data, and coexist with generic API, frontend, storage, authentication, payments, CI, and model-runtime concepts.

Version 3.3.0 is repository-grade and self-tested, but it should not be described as an infallible or operating-system-level sandbox. Its value is disciplined engineering coordination and evidence, with explicit limits documented in the security model.
