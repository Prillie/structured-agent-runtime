# Structured Agent Runtime

A compact TypeScript system for turning a structured request into an evidence-backed result or a human-reviewed action. It separates model generation, deterministic capabilities, persistent context, and authority to act.

The demo analyzes synthetic workflow metrics and proposes a work ticket. **A model can propose a ticket; only an explicit human review can create it.** Nothing is sent to an external service.

## Run it

Use **Node.js 24** and npm. SQLite is provided by Node; no database service or API key is needed.

```sh
npm ci
npm run check
npm run demo
```

The CLI displays the result and exact proposed action. Type `approve` at the review prompt to write that ticket to the local SQLite outbox; any other response rejects it. Runs, context, review decisions, and tickets survive restarts in `.data/workflows.sqlite`.

The example uses a stable request ID. Running it again replays the saved result. Edit `examples/request.json` and use a **new ID** for a new workflow. Change `intent` to `research` or `drafting` to exercise the other capabilities. Set `action` to `none` for an informational result.

## Architecture

```mermaid
flowchart TD
    A[Structured request] --> B[Validate and authorize workspace]
    B --> C[Load persistent context]
    C --> D[Policy router]
    D --> E[Read-only capability]
    E --> F[Provider and model tier]
    F --> G[Validate structure and evidence references]
    F --> H{Bounded failure policy}
    G -->|Invalid output| H
    H -->|Retryable within budget| F
    H -->|Informational fallback| J
    H -->|Action failure| P[Blocked with no action]
    G --> I{Action requested?}
    I -->|No| J[Persist informational result]
    I -->|Yes| K[Persist immutable proposal]
    K --> L[Human review with proposal digest]
    L --> M{Approve?}
    M -->|Yes| N[Atomic review and local outbox write]
    M -->|No| O[Persist rejection]
```

## Engineering choices

- **Structured intent controls routing.** Research uses knowledge search, analysis computes metrics, and drafting loads a brief template. Analysis routes to a reasoning model tier; the other tasks use an economy tier. Policy selects capabilities rather than granting the model arbitrary tools.
- **Compute before generating.** The metric capability calculates success rates deterministically. The model explains supplied evidence rather than inventing arithmetic. Zod validates input and output, and the runtime rejects citations outside the capability's evidence set. Reference validation does not prove every sentence is factually correct.
- **Keep model providers replaceable.** A small provider interface supports a deterministic local provider and an AI SDK adapter. The latter accepts provider model objects or AI Gateway model identifiers; routing stays independent of vendor details.
- **Store context outside the model.** Bounded workspace notes and version numbers persist in SQLite. Each run records the context version it read. A saved request ID replays its result; reusing it with different input is rejected.
- **Separate a proposal from permission.** Every supported action requires a human review of the saved proposal digest. Approval expires after 15 minutes. Workspace checks, terminal review states, and a unique outbox key prevent cross-workspace review, approval replay, or duplicate local effects.
- **Make failures explicit.** Only transient provider errors and deadlines retry, at most three attempts. Informational workflows can return labeled deterministic evidence summaries. An action request that fails generation is blocked with no approvable action.
- **Keep telemetry narrow.** Hooks report phases, attempt counts, and timing metadata. They omit raw questions, context, model responses, and provider error details. Observer failures cannot change workflow outcomes.

## Optional live models

The default provider is synthetic and makes no network calls. For live generation, copy `.env.example` to `.env`, set an AI Gateway key and current `provider/model` identifiers for both tiers, then run:

```sh
node --env-file=.env --import tsx src/cli.ts --live
```

Choose identifiers from the [current AI Gateway model catalog](https://vercel.com/docs/ai-gateway/models-and-providers). Live calls incur provider usage. Credentials remain local and ignored by Git.

The adapter uses the installed AI SDK's `generateText` and `Output.object` APIs. Its model selection, schema configuration, cancellation, and error classification are unit tested with mocked network boundaries. Live provider connectivity is optional and is not claimed by the offline test suite.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Tests cover routing, real capability arithmetic, strict schema validation, persisted context, request replay, concurrent saves, cross-workspace access, restart recovery, approval integrity, expiration, rejection, duplicate effects across SQLite connections, malformed output, ungrounded references, unrequested actions, retries, deadlines, fallback policy, and telemetry privacy. GitHub Actions runs the checks and build without credentials.

## Layout

```text
src/
  contracts.ts      Validated boundaries and provider contracts
  capabilities.ts   Policy routing and synthetic read-only tools
  providers.ts      Deterministic and AI SDK adapters
  runtime.ts        Orchestration, validation, deadlines, failure policy
  store.ts          SQLite context, run state, review, and local outbox
  cli.ts            Working local demo with explicit review
tests/
examples/request.json
```

## Scope and operating boundaries

This is a standalone engineering showcase, built from scratch with synthetic data. It demonstrates production-oriented patterns in a small local runtime; it is not a hosted service.

The local CLI treats the person running it as the reviewer. An HTTP integration must authenticate callers and derive workspace authority on the server before invoking the runtime. The storage layer is trusted internal code, not a public API. Keep the database on durable disk; ephemeral serverless storage is unsuitable.

Approval and ticket insertion share one SQLite transaction. This guarantees a single local outbox record, not exactly-once delivery to an external API. A real dispatcher needs provider idempotency, retries, and reconciliation. Concurrent identical requests can spend inference twice before one canonical result is saved. The context version records a snapshot; it does not serialize model generation across a workspace. Add reservations and stronger context concurrency controls if that becomes a requirement.

Input length, context size, attempt count, response token budget, and per-call duration are bounded. A provider that ignores cancellation may continue its own work after the runtime times out. Output validation and capability isolation reduce risk; they are not a general prompt-injection defense.

MIT licensed. No production application source, business prompts, customer data, or commercial schemas are included.
