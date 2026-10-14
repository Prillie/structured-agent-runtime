import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoApi } from "../src/http.js";
import { Runtime } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { SyntheticProvider } from "../src/providers.js";

describe("authenticated HTTP boundary", () => {
  const credential = randomBytes(32).toString("hex");
  const input = {
    id: "http-test",
    intent: "analysis",
    question: "Analyze workflow metrics",
    action: "none",
  };
  let store: Store;
  let runtime: Runtime;
  let server: ReturnType<typeof createDemoApi>;
  let url: string;
  beforeEach(async () => {
    store = new Store();
    runtime = new Runtime(store, new SyntheticProvider());
    server = createDemoApi(runtime, credential);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/runs`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    vi.restoreAllMocks();
  });
  const headers = () => ({
    authorization: `Bearer ${credential}`,
    "content-type": "application/json",
  });
  it("derives the principal and workspace from authenticated server state", async () => {
    const spy = vi.spyOn(runtime, "run");
    const response = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "complete",
      request: { workspace: "http-demo" },
    });
    expect(spy).toHaveBeenCalledWith(
      { ...input, workspace: "http-demo" },
      { subject: "demo-client", workspace: "http-demo" },
    );
    expect(store.context("http-demo").version).toBe(1);
  });
  it.each([undefined, "Bearer incorrect", "Basic unsupported"])(
    "rejects invalid authentication before inference: %s",
    async (authorization) => {
      const spy = vi.spyOn(runtime, "run");
      const response = await fetch(url, {
        method: "POST",
        headers: authorization ? { authorization } : {},
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    },
  );
  it.each([{ workspace: "other" }, { subject: "admin" }, { approved: true }])(
    "rejects client-supplied authority fields",
    async (fields) => {
      const spy = vi.spyOn(runtime, "run");
      const response = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ...input, ...fields }),
      });
      expect(response.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
      expect(store.context("other").version).toBe(0);
    },
  );
  it("leaves consequential actions provisional instead of auto-approving", async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ...input, action: "create_ticket" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "pending" });
    expect(store.tickets("http-demo")).toEqual([]);
    expect(store.context("http-demo")).toEqual({ version: 0, notes: [] });
  });
  it("returns a conflict for changed input under a saved request ID", async () => {
    await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(input),
    });
    const response = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ...input, question: "A different question" }),
    });
    expect(response.status).toBe(409);
  });
  it("bounds bodies and rejects malformed JSON", async () => {
    const large = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: "x".repeat(20_000),
    });
    expect(large.status).toBe(413);
    const malformed = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });
  it("rejects unsupported media types and routes", async () => {
    const media = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      body: "not-json",
    });
    expect(media.status).toBe(415);
    expect((await fetch(url)).status).toBe(404);
  });
});
