import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Runtime } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { RetryableError, SyntheticProvider } from "../src/providers.js";
import {
  requestSchema,
  type GenerationInput,
  type Provider,
  type Request,
} from "../src/contracts.js";
import { route, invokeCapability } from "../src/capabilities.js";

const principal = { workspace: "demo", subject: "reviewer" };
const request: Request = {
  id: "r1",
  workspace: "demo",
  intent: "analysis",
  question: "Analyze weekly workflow metrics",
  action: "none",
};
const stores: Store[] = [];
function setup(
  provider: Provider = new SyntheticProvider(),
  options: ConstructorParameters<typeof Runtime>[2] = {},
) {
  const store = new Store();
  stores.push(store);
  return {
    store,
    runtime: new Runtime(store, provider, { wait: async () => {}, ...options }),
  };
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});
function fake(fn: Provider["generate"]): Provider {
  return { name: "fault-test", generate: fn };
}

describe("routing and capability selection", () => {
  it.each([
    ["research", "knowledge_search", "economy"],
    ["analysis", "metric_analysis", "reasoning"],
    ["drafting", "draft_brief", "economy"],
  ] as const)("routes %s using policy", (intent, capability, tier) => {
    expect(route({ ...request, intent })).toEqual({ capability, tier });
  });
  it("computes metrics with deterministic arithmetic", () => {
    const evidence = invokeCapability(route(request), request);
    expect(evidence[0]?.text).toContain("80%");
    expect(evidence[1]?.text).toContain("92%");
  });
  it("rejects additional input fields and unsupported actions", () => {
    expect(() => requestSchema.parse({ ...request, approved: true })).toThrow();
    expect(() =>
      requestSchema.parse({ ...request, action: "send_email" }),
    ).toThrow();
  });
  it("rejects invalid input before invoking a model", async () => {
    const generate = vi.fn();
    const { runtime } = setup(fake(generate));
    await expect(
      runtime.run({ ...request, question: "" }, principal),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("context and idempotency", () => {
  it("supplies the prior context on subsequent requests", async () => {
    const seen: GenerationInput[] = [];
    const synthetic = new SyntheticProvider();
    const { runtime, store } = setup(
      fake(async (input, signal) => {
        seen.push(input);
        return synthetic.generate(input, signal);
      }),
    );
    await runtime.run(request, principal);
    await runtime.run({ ...request, id: "r2" }, principal);
    expect(seen[1]?.context.version).toBe(1);
    expect(seen[1]?.context.notes[0]).toContain("Week 1");
    expect(store.context("demo").version).toBe(2);
  });
  it("replays an existing request without new inference or context writes", async () => {
    const provider = new SyntheticProvider();
    const spy = vi.spyOn(provider, "generate");
    const { runtime, store } = setup(provider);
    const first = await runtime.run(request, principal);
    expect(await runtime.run(request, principal)).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.context("demo").version).toBe(1);
    await expect(
      runtime.run({ ...request, question: "Different request" }, principal),
    ).rejects.toThrow("reused");
  });
  it("isolates workspace data and rejects unauthorized requests", async () => {
    const { runtime, store } = setup();
    await runtime.run(request, principal);
    expect(store.context("other").notes).toEqual([]);
    await expect(
      runtime.run({ ...request, workspace: "other" }, principal),
    ).rejects.toThrow("denied");
  });
  it("keeps one canonical result under concurrent requests", async () => {
    const { runtime, store } = setup();
    const [a, b] = await Promise.all([
      runtime.run(request, principal),
      runtime.run(request, principal),
    ]);
    expect(a).toEqual(b);
    expect(store.context("demo").version).toBe(1);
  });
  it("retains canonical context and a provisional proposal across a process restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-runtime-"));
    const file = join(dir, "test.sqlite");
    const first = new Store(file);
    await new Runtime(first, new SyntheticProvider()).run(
      { ...request, id: "informational" },
      principal,
    );
    const canonical = first.context("demo");
    const input = { ...request, action: "create_ticket" };
    const run = await new Runtime(first, new SyntheticProvider()).run(
      input,
      principal,
    );
    first.close();
    const second = new Store(file);
    try {
      expect(second.context("demo")).toEqual(canonical);
      expect(second.find("demo", request.id)).toEqual(run);
      new Runtime(second, new SyntheticProvider()).review(
        {
          workspace: "demo",
          requestId: request.id,
          digest: run.digest,
          decision: "approve",
        },
        principal,
      );
      expect(second.tickets("demo")).toHaveLength(1);
      expect(second.context("demo")).toEqual({
        version: 2,
        notes: [...canonical.notes, run.output.summary],
      });
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("human approval", () => {
  async function pending(options = {}) {
    const pair = setup(undefined, options);
    const run = await pair.runtime.run(
      { ...request, action: "create_ticket" },
      principal,
    );
    const review = {
      workspace: "demo",
      requestId: request.id,
      digest: run.digest,
      decision: "approve",
    };
    return { ...pair, run, review };
  }
  it("creates no ticket until the exact proposal is approved", async () => {
    const { store, runtime, run, review } = await pending();
    expect(run.status).toBe("pending");
    expect(store.tickets("demo")).toEqual([]);
    expect(store.context("demo")).toEqual({ version: 0, notes: [] });
    expect(runtime.review(review, principal).status).toBe("approved");
    expect(store.tickets("demo")).toHaveLength(1);
    expect(store.tickets("demo")[0]).toMatchObject({
      action: run.output.action,
      reviewer: "reviewer",
    });
    expect(store.context("demo")).toEqual({
      version: 1,
      notes: [run.output.summary],
    });
  });
  it("keeps provisional and rejected summaries out of subsequent model context", async () => {
    const seen: GenerationInput[] = [];
    const synthetic = new SyntheticProvider();
    const { runtime, store } = setup(
      fake(async (input, signal) => {
        seen.push(input);
        const output = (await synthetic.generate(input, signal)) as Record<
          string,
          unknown
        >;
        return { ...output, summary: `Summary for ${input.request.id}` };
      }),
    );
    const proposal = await runtime.run(
      { ...request, action: "create_ticket" },
      principal,
    );
    await runtime.run({ ...request, id: "before-review" }, principal);
    expect(seen[1]?.context).toEqual({ version: 0, notes: [] });
    const canonical = store.context("demo");
    runtime.review(
      {
        workspace: "demo",
        requestId: request.id,
        digest: proposal.digest,
        decision: "reject",
      },
      principal,
    );
    expect(store.find("demo", request.id)?.status).toBe("rejected");
    expect(store.context("demo")).toEqual(canonical);
    await runtime.run({ ...request, id: "after-rejection" }, principal);
    expect(seen[2]?.context).toEqual(canonical);
  });
  it("supplies an approved summary to the next workflow", async () => {
    const seen: GenerationInput[] = [];
    const synthetic = new SyntheticProvider();
    const { runtime } = setup(
      fake(async (input, signal) => {
        seen.push(input);
        return synthetic.generate(input, signal);
      }),
    );
    const proposal = await runtime.run(
      { ...request, action: "create_ticket" },
      principal,
    );
    runtime.review(
      {
        workspace: "demo",
        requestId: request.id,
        digest: proposal.digest,
        decision: "approve",
      },
      principal,
    );
    await runtime.run({ ...request, id: "after-approval" }, principal);
    expect(seen[1]?.context).toEqual({
      version: 1,
      notes: [proposal.output.summary],
    });
  });
  it("rolls back approval, outbox, and memory together when promotion fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-memory-"));
    const file = join(dir, "test.sqlite");
    const store = new Store(file);
    const db = new DatabaseSync(file);
    try {
      const runtime = new Runtime(store, new SyntheticProvider());
      const run = await runtime.run(
        { ...request, action: "create_ticket" },
        principal,
      );
      db.exec(
        "CREATE TRIGGER fail_context BEFORE INSERT ON contexts BEGIN SELECT RAISE(ABORT, 'Memory unavailable'); END",
      );
      const review = {
        workspace: "demo",
        requestId: request.id,
        digest: run.digest,
        decision: "approve",
      };
      expect(() => runtime.review(review, principal)).toThrow(
        "Memory unavailable",
      );
      expect(store.find("demo", request.id)?.status).toBe("pending");
      expect(store.tickets("demo")).toEqual([]);
      expect(store.context("demo")).toEqual({ version: 0, notes: [] });
      db.exec("DROP TRIGGER fail_context");
      runtime.review(review, principal);
      expect(store.tickets("demo")).toHaveLength(1);
      expect(store.context("demo")).toEqual({
        version: 1,
        notes: [run.output.summary],
      });
    } finally {
      db.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects a changed proposal digest and preserves pending state", async () => {
    const { runtime, review, store } = await pending();
    expect(() =>
      runtime.review({ ...review, digest: "a".repeat(64) }, principal),
    ).toThrow("match");
    expect(store.find("demo", request.id)?.status).toBe("pending");
    expect(store.tickets("demo")).toHaveLength(0);
    expect(store.context("demo")).toEqual({ version: 0, notes: [] });
  });
  it("rejects expired approvals", async () => {
    let now = 0;
    const { runtime, review, store } = await pending({ now: () => now });
    now = 15 * 60_000;
    expect(() => runtime.review(review, principal)).toThrow("expired");
    expect(store.tickets("demo")).toHaveLength(0);
    expect(store.context("demo")).toEqual({ version: 0, notes: [] });
  });
  it("cannot approve a rejected proposal", async () => {
    const { runtime, review, store } = await pending();
    runtime.review({ ...review, decision: "reject" }, principal);
    expect(() => runtime.review(review, principal)).toThrow("pending");
    expect(store.tickets("demo")).toEqual([]);
    expect(store.context("demo")).toEqual({ version: 0, notes: [] });
  });
  it("prevents replay and duplicate local effects across two connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-approval-"));
    const file = join(dir, "test.sqlite");
    const a = new Store(file);
    const b = new Store(file);
    try {
      const ra = new Runtime(a, new SyntheticProvider());
      const rb = new Runtime(b, new SyntheticProvider());
      const run = await ra.run(
        { ...request, action: "create_ticket" },
        principal,
      );
      const review = {
        workspace: "demo",
        requestId: request.id,
        digest: run.digest,
        decision: "approve",
      };
      ra.review(review, principal);
      expect(() => rb.review(review, principal)).toThrow("pending");
      expect(b.tickets("demo")).toHaveLength(1);
      expect(b.context("demo")).toEqual({
        version: 1,
        notes: [run.output.summary],
      });
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("requires the same workspace principal when reviewing", async () => {
    const { runtime, review, store } = await pending();
    expect(() =>
      runtime.review(review, { workspace: "other", subject: "intruder" }),
    ).toThrow("denied");
    expect(store.tickets("demo")).toHaveLength(0);
  });
  it("does not approve an informational response", async () => {
    const { runtime } = setup();
    const run = await runtime.run(request, principal);
    expect(() =>
      runtime.review(
        {
          workspace: "demo",
          requestId: request.id,
          digest: run.digest,
          decision: "approve",
        },
        principal,
      ),
    ).toThrow("pending");
  });
});

describe("failure policy and observability", () => {
  it.each([
    null,
    { summary: "Bad", evidence: [], action: null },
    { summary: "Bad", evidence: ["invented-reference"], action: null },
  ])("falls back on malformed or ungrounded output", async (raw) => {
    const { runtime } = setup(fake(async () => raw));
    const run = await runtime.run(request, principal);
    expect(run.source).toBe("deterministic-fallback");
    expect(run.status).toBe("complete");
    expect(run.output.evidence).toEqual(["metric-week-1", "metric-week-2"]);
  });
  it("blocks consequential requests on model failure", async () => {
    const { runtime, store } = setup(
      fake(async () => {
        throw new Error("Provider failure with sensitive detail");
      }),
    );
    const run = await runtime.run(
      { ...request, action: "create_ticket" },
      principal,
    );
    expect(run.status).toBe("blocked");
    expect(run.output.action).toBeNull();
    expect(store.context("demo").version).toBe(0);
    expect(store.tickets("demo")).toEqual([]);
    expect(JSON.stringify(run)).not.toContain("sensitive detail");
  });
  it("rejects model attempts to add an unrequested action", async () => {
    const synthetic = new SyntheticProvider();
    const { runtime } = setup(
      fake((input, signal) =>
        synthetic.generate(
          { ...input, request: { ...input.request, action: "create_ticket" } },
          signal,
        ),
      ),
    );
    const run = await runtime.run(request, principal);
    expect(run.source).toBe("deterministic-fallback");
    expect(run.output.action).toBeNull();
  });
  it("retries only transient failures with bounded backoff", async () => {
    let calls = 0;
    const wait = vi.fn(async () => {});
    const synthetic = new SyntheticProvider();
    const { runtime } = setup(
      fake(async (input, signal) => {
        if (++calls === 1) throw new RetryableError("Rate limited");
        return synthetic.generate(input, signal);
      }),
      { wait },
    );
    expect((await runtime.run(request, principal)).source).toBe("fault-test");
    expect(calls).toBe(2);
    expect(wait).toHaveBeenCalledWith(50);
  });
  it("does not retry permanent failures or malformed model outputs", async () => {
    const generate = vi.fn(async () => ({}));
    const { runtime } = setup(fake(generate));
    await runtime.run(request, principal);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("exhausts the retry budget before informational fallback", async () => {
    const generate = vi.fn(async () => {
      throw new RetryableError("Unavailable");
    });
    const { runtime } = setup(fake(generate), { attempts: 3 });
    expect((await runtime.run(request, principal)).source).toBe(
      "deterministic-fallback",
    );
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it("bounds a provider that ignores its cancellation signal", async () => {
    const { runtime } = setup(
      fake(async () => new Promise(() => {})),
      { attempts: 1, timeoutMs: 5 },
    );
    expect((await runtime.run(request, principal)).source).toBe(
      "deterministic-fallback",
    );
  });
  it("logs lifecycle metadata without raw input, context, or output", async () => {
    const observe = vi.fn();
    const { runtime } = setup(undefined, { observe });
    await runtime.run(request, principal);
    expect(observe.mock.calls.map(([event]) => event.phase)).toEqual([
      "tool",
      "model",
      "complete",
    ]);
    expect(JSON.stringify(observe.mock.calls)).not.toContain(request.question);
  });
  it("isolates observer failures from state changes", async () => {
    const { runtime } = setup(undefined, {
      observe: () => {
        throw new Error("Hook failed");
      },
    });
    expect((await runtime.run(request, principal)).status).toBe("complete");
  });
});
