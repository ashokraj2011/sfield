import { test } from "node:test";
import { EphemeralPersistence } from "@sfield/core";
import { persistenceConformance } from "../conformance.js";

for (const c of persistenceConformance(async () => {
  const p = new EphemeralPersistence();
  await p.init({ namespace: "test", ownerId: "t" });
  return p;
})) {
  test(`ephemeral persistence conformance: ${c.name}`, () => c.run());
}
