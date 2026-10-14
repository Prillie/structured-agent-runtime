import { describe, expect, it, vi } from "vitest";
import { AiSdkProvider, RetryableError } from "../src/providers.js";
import { generateText, type LanguageModel } from "ai";
import { route, invokeCapability } from "../src/capabilities.js";
import type { GenerationInput, Request } from "../src/contracts.js";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: { object: vi.fn((value) => value) },
}));
const request: Request = {
  id: "test",
  workspace: "demo",
  intent: "analysis",
  question: "Analyze metrics",
  action: "none",
};
const input: GenerationInput = {
  request,
  context: { version: 0, notes: [] },
  route: route(request),
  evidence: invokeCapability(route(request), request),
};

describe("AI SDK adapter", () => {
  it("selects the routed model and passes schema, cancellation, and bounded generation", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      output: { summary: "Valid", evidence: ["metric-week-1"], action: null },
    } as Awaited<ReturnType<typeof generateText>>);
    const signal = new AbortController().signal;
    const provider = new AiSdkProvider({
      economy: "demo/economy" as LanguageModel,
      reasoning: "demo/reasoning" as LanguageModel,
    });
    expect(await provider.generate(input, signal)).toMatchObject({
      summary: "Valid",
    });
    expect(generateText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "demo/reasoning",
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: 1200,
      }),
    );
  });
  it("classifies a rate limit as transient and leaves authentication failure permanent", async () => {
    const provider = new AiSdkProvider({
      economy: "demo/economy" as LanguageModel,
      reasoning: "demo/reasoning" as LanguageModel,
    });
    vi.mocked(generateText).mockRejectedValueOnce({ statusCode: 429 });
    await expect(
      provider.generate(input, new AbortController().signal),
    ).rejects.toBeInstanceOf(RetryableError);
    vi.mocked(generateText).mockRejectedValueOnce({ statusCode: 401 });
    await expect(
      provider.generate(input, new AbortController().signal),
    ).rejects.toEqual({ statusCode: 401 });
  });
});
