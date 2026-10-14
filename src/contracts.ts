import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const requestSchema = z.strictObject({
  id: identifier,
  workspace: identifier,
  intent: z.enum(["research", "analysis", "drafting"]),
  question: z.string().trim().min(3).max(2000),
  action: z.enum(["none", "create_ticket"]),
});
export const contextSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  notes: z.array(z.string().max(2000)).max(20),
});
export const outputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().min(1).max(80)).max(10),
  action: z.union([
    z.null(),
    z.strictObject({
      kind: z.literal("create_ticket"),
      title: z.string().trim().min(3).max(120),
      body: z.string().trim().min(3).max(2000),
    }),
  ]),
});
export const reviewSchema = z.strictObject({
  workspace: identifier,
  requestId: identifier,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approve", "reject"]),
});
export type Request = z.infer<typeof requestSchema>;
export type Context = z.infer<typeof contextSchema>;
export type Output = z.infer<typeof outputSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Route = {
  capability: "knowledge_search" | "metric_analysis" | "draft_brief";
  tier: "economy" | "reasoning";
};
export type Evidence = { id: string; text: string };
export type GenerationInput = {
  request: Request;
  context: Context;
  route: Route;
  evidence: Evidence[];
};
export interface Provider {
  readonly name: string;
  generate(input: GenerationInput, signal: AbortSignal): Promise<unknown>;
}
export type Event = {
  requestId: string;
  phase: "tool" | "model" | "retry" | "fallback" | "complete";
  provider?: string;
  attempt?: number;
  durationMs?: number;
};
export type Observer = (event: Event) => void;
export type Run = {
  request: Request;
  fingerprint: string;
  contextVersion: number;
  output: Output;
  route: Route;
  status: "complete" | "pending" | "approved" | "rejected" | "blocked";
  source: string;
  digest: string;
  expiresAt: number;
};
