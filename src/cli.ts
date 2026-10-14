import { mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { z } from "zod";
import { Runtime } from "./runtime.js";
import { Store } from "./store.js";
import { AiSdkProvider, SyntheticProvider } from "./providers.js";
import { requestSchema } from "./contracts.js";

const live = process.argv.includes("--live");
const config = live
  ? z
      .object({
        AI_GATEWAY_API_KEY: z.string().min(1),
        ECONOMY_MODEL: z.string().regex(/^[\w-]+\/[\w.-]+$/),
        REASONING_MODEL: z.string().regex(/^[\w-]+\/[\w.-]+$/),
      })
      .parse(process.env)
  : undefined;
const provider = config
  ? new AiSdkProvider({
      economy: config.ECONOMY_MODEL,
      reasoning: config.REASONING_MODEL,
    })
  : new SyntheticProvider();
mkdirSync(resolve(".data"), { recursive: true });
const store = new Store(resolve(".data/workflows.sqlite"));
const runtime = new Runtime(store, provider, {
  observe: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
});
const input = requestSchema.parse(
  JSON.parse(
    readFileSync(new URL("../examples/request.json", import.meta.url), "utf8"),
  ),
);
// Local CLI authority only. An HTTP host must authenticate and derive its own principal.
const principal = { workspace: input.workspace, subject: "local-reviewer" };
try {
  const run = await runtime.run(input, principal);
  stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  if (run.status === "pending") {
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await reader.question(
        "Type approve to create this exact synthetic ticket; anything else rejects: ",
      );
      const result = runtime.review(
        {
          workspace: input.workspace,
          requestId: input.id,
          digest: run.digest,
          decision: answer === "approve" ? "approve" : "reject",
        },
        principal,
      );
      stdout.write(`Review: ${result.status}\n`);
    } finally {
      reader.close();
    }
  }
  stdout.write(
    `${JSON.stringify({ tickets: store.tickets(input.workspace) }, null, 2)}\n`,
  );
} finally {
  store.close();
}
