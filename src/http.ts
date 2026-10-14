import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { requestSchema } from "./contracts.js";
import type { Runtime } from "./runtime.js";

const bodySchema = requestSchema.omit({ workspace: true });
const hash = (value: string) => createHash("sha256").update(value).digest();

/** Single-client demo authentication; a production host supplies its session/tenant lookup. */
export function createDemoApi(runtime: Runtime, credential: string) {
  const expected = hash(z.string().min(32).parse(credential));
  const principal = { subject: "demo-client", workspace: "http-demo" };
  const server = createServer(async (request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/runs") {
      request.resume();
      return reply(404, { error: "Not found" });
    }
    const authorization = request.headers.authorization ?? "";
    if (
      !authorization.startsWith("Bearer ") ||
      !timingSafeEqual(hash(authorization.slice(7)), expected)
    ) {
      request.resume();
      return reply(401, { error: "Unauthorized" });
    }
    if (
      request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      request.resume();
      return reply(415, { error: "Expected application/json" });
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 16_384) {
          request.resume();
          return reply(413, { error: "Body too large" });
        }
        chunks.push(bytes);
      }
      // Identity and workspace never come from JSON or model output.
      const body = bodySchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const run = await runtime.run(
        { ...body, workspace: principal.workspace },
        principal,
      );
      return reply(run.status === "pending" ? 202 : 200, run);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return reply(400, { error: "Invalid request" });
      if (
        error instanceof Error &&
        error.message === "Request ID reused with different input"
      )
        return reply(409, { error: "Request ID conflict" });
      return reply(500, { error: "Workflow failed" });
    }
  });
  server.requestTimeout = 5_000;
  return server;
}
