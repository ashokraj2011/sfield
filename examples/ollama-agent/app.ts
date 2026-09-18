// ollama-agent/app.ts — the minimal application (§4.3)
import { SField } from "@sfield/core";
import { tools } from "./tools.ts";

const sf = await SField.create({ preset: "local", config: "./sfield.yaml", tools });

const session = await sf.sessions.open({ agent: "support" });
const run = await session.send({ message: { text: process.argv[2] ?? "What is the refund policy?" } });
for await (const ev of run.events()) {
  if (ev.type === "text_delta") process.stdout.write(String(ev.payload.text));
}
const result = await run.result();
console.log("\n" + JSON.stringify({ state: result.state, output: result.output, usage: result.usage }, null, 2));
await sf.close();
