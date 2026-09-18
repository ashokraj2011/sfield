import { SField } from "@sfield/core";
import type { ParsedArgs } from "../args.js";
import { loadWiring } from "../wiring.js";

/** Creates an instance from the wiring (preset or host module). Callers must close it. */
export async function openField(args: ParsedArgs): Promise<SField> {
  const wiring = await loadWiring(args);
  return SField.create({ ...wiring.options, quiet: true });
}
