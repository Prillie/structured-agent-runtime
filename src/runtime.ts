import { setTimeout as sleep } from "node:timers/promises";
import {
  requestSchema,
  outputSchema,
  reviewSchema,
  type GenerationInput,
  type Observer,
  type Output,
  type Provider,
  type Run,
} from "./contracts.js";
import { invokeCapability, route } from "./capabilities.js";
import { RetryableError, SyntheticProvider } from "./providers.js";
import { digest, Store } from "./store.js";

type Options = {
  attempts?: number;
  timeoutMs?: number;
  observe?: Observer;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
};
type Principal = { workspace: string; subject: string };

/** Principal comes from the trusted host; never derive it from model output. */
function authorize(workspace: string, principal: Principal): void {
  if (principal.workspace !== workspace || !principal.subject.trim())
    throw new Error("Workspace access denied");
}
function validate(raw: unknown, input: GenerationInput): Output {
  const output = outputSchema.parse(raw);
  const ids = new Set(input.evidence.map((item) => item.id));
  if (!output.evidence.length || output.evidence.some((id) => !ids.has(id)))
    throw new Error("Ungrounded evidence references");
  if (input.request.action === "none" && output.action)
    throw new Error("Unrequested action");
  if (input.request.action !== "none" && !output.action)
    throw new Error("Requested action missing");
  return output;
}

export class Runtime {
  private readonly attempts: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  constructor(
    private readonly store: Store,
    private readonly provider: Provider,
    private readonly options: Options = {},
  ) {
    this.attempts = options.attempts ?? 2;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isInteger(this.attempts) ||
      this.attempts < 1 ||
      this.attempts > 3
    )
      throw new Error("Attempts must be 1–3");
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000
    )
      throw new Error("Timeout must be 1–60000ms");
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => sleep(ms));
  }
  private emit(event: Parameters<Observer>[0]): void {
    try {
      this.options.observe?.(event);
    } catch {
      /* Diagnostic hooks cannot change workflow outcomes. */
    }
  }
  private async generate(input: GenerationInput): Promise<Output> {
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = this.now();
      this.emit({
        requestId: input.request.id,
        phase: "model",
        provider: this.provider.name,
        attempt,
      });
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new RetryableError("Model deadline exceeded"));
          }, this.timeoutMs);
        });
        const raw = await Promise.race([
          this.provider.generate(input, controller.signal),
          timeout,
        ]);
        return validate(raw, input);
      } catch (error) {
        if (!(error instanceof RetryableError) || attempt === this.attempts)
          throw error;
        this.emit({
          requestId: input.request.id,
          phase: "retry",
          attempt,
          durationMs: this.now() - started,
        });
      } finally {
        clearTimeout(timer);
      }
      await this.wait(50 * 2 ** (attempt - 1));
    }
    throw new Error("Retry budget exhausted");
  }
  async run(raw: unknown, principal: Principal): Promise<Run> {
    const request = requestSchema.parse(raw);
    authorize(request.workspace, principal);
    const fingerprint = digest(request);
    const existing = this.store.find(request.workspace, request.id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("Request ID reused with different input");
      return existing;
    }
    const selected = route(request);
    const context = this.store.context(request.workspace);
    const evidence = invokeCapability(selected, request);
    this.emit({ requestId: request.id, phase: "tool" });
    const input = { request, context, route: selected, evidence };
    let output: Output;
    let source = this.provider.name;
    let status: Run["status"] =
      request.action === "none" ? "complete" : "pending";
    try {
      output = await this.generate(input);
    } catch {
      source = "deterministic-fallback";
      this.emit({ requestId: request.id, phase: "fallback" });
      if (request.action !== "none") {
        status = "blocked";
        output = {
          summary:
            "Generation failed. No action is available; submit a new request after resolving the provider failure.",
          evidence: [],
          action: null,
        };
      } else {
        output = validate(
          await new SyntheticProvider().generate(
            input,
            new AbortController().signal,
          ),
          input,
        );
      }
    }
    const run = this.store.save({
      request,
      fingerprint,
      contextVersion: context.version,
      output,
      route: selected,
      status,
      source,
      digest: digest(output),
      expiresAt: this.now() + 15 * 60_000,
    });
    this.emit({ requestId: request.id, phase: "complete" });
    return run;
  }
  review(raw: unknown, principal: Principal): Run {
    const review = reviewSchema.parse(raw);
    authorize(review.workspace, principal);
    return this.store.review(review, principal.subject, this.now());
  }
}
