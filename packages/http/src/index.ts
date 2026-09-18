/** @sfield/http public surface: the reference HTTP tool adapter (§8.5, §23.2). */
import type { SFieldPlugin } from "@sfield/core";
import { HttpAdapter } from "./adapter.js";

export { HttpAdapter, HTTP_OPERATION_SCHEMA, HTTP_METHODS, HTTP_RESPONSE_KINDS } from "./adapter.js";
export type { HttpOperation, HttpMethod, HttpResponseKind, KeyLocation } from "./adapter.js";

export function httpAdapter(): HttpAdapter {
  return new HttpAdapter();
}

/** Registers the adapter under `adapter: http` (§6.1). It needs no bindings of its own: tools name their connection. */
export function httpPlugin(): SFieldPlugin {
  return {
    manifest: {
      id: "http",
      version: "0.1.0",
      apiVersion: 1,
      coreCompatibility: "^0.1.0",
      buildDigest: "sha256:6d1f0a9c3b7e5248d0c4e8a1f3b6c9d2",
      requires: [],
    },
    register(registrar) {
      registrar.adapter(new HttpAdapter());
    },
  };
}
