import { z } from "zod";
import type { Evidence, Request, Route } from "./contracts.js";

export const records = [
  {
    id: "guide-review",
    text: "Review the draft and supporting evidence before creating a work ticket.",
  },
  {
    id: "guide-reliability",
    text: "Measure failed attempts separately from completed workflows.",
  },
  {
    id: "guide-scope",
    text: "Keep work scoped to one synthetic workspace and one requested action.",
  },
] as const;
const measurements = z
  .array(
    z.strictObject({
      week: z.number().int().positive(),
      completed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  )
  .parse([
    { week: 1, completed: 80, failed: 20 },
    { week: 2, completed: 92, failed: 8 },
  ]);

export function route(request: Request): Route {
  switch (request.intent) {
    case "research":
      return { capability: "knowledge_search", tier: "economy" };
    case "analysis":
      return { capability: "metric_analysis", tier: "reasoning" };
    case "drafting":
      return { capability: "draft_brief", tier: "economy" };
  }
}

/** Capabilities are policy-selected, read-only, and have no external network access. */
export function invokeCapability(
  selected: Route,
  request: Request,
): Evidence[] {
  switch (selected.capability) {
    case "knowledge_search": {
      const words = request.question
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length > 3);
      const matches = records.filter((record) =>
        words.some((word) => record.text.toLowerCase().includes(word)),
      );
      return (matches.length ? matches : [records[0]]).map((record) => ({
        ...record,
      }));
    }
    case "metric_analysis":
      return measurements.map((row) => ({
        id: `metric-week-${row.week}`,
        text: `Week ${row.week}: ${row.completed} completed, ${row.failed} failed; success rate ${Math.round((row.completed / (row.completed + row.failed)) * 100)}%.`,
      }));
    case "draft_brief":
      return [
        {
          id: "brief-template",
          text: "A work brief needs a title, evidence, acceptance criteria, and a reviewer.",
        },
      ];
  }
}
