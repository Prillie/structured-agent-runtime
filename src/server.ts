import { mkdirSync } from "node:fs";
import { z } from "zod";
import { createDemoApi } from "./http.js";
import { Runtime } from "./runtime.js";
import { Store } from "./store.js";
import { SyntheticProvider } from "./providers.js";

const credential = z.string().min(32).parse(process.env.API_DEMO_TOKEN);
mkdirSync(".data", { recursive: true });
const store = new Store(".data/http-demo.sqlite");
const server = createDemoApi(
  new Runtime(store, new SyntheticProvider()),
  credential,
);
server.listen(3000, "127.0.0.1", () => {
  process.stdout.write("Demo API listening on port 3000; POST /runs\n");
});
const shutdown = () =>
  server.close(() => {
    store.close();
  });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
