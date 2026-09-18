/** Development authorizer (§4.3): exactly one local principal, restricted to configured capabilities. */
import type { Principal } from "./types/common.js";
import type { AuthorizationRequest, Authorizer } from "./types/options.js";
import { isoAfter } from "./util/digest.js";

export const LOCAL_DEV_PRINCIPAL: Principal = Object.freeze({ tenantId: "local", subjectId: "developer", roles: Object.freeze(["developer"]) as readonly string[], attributes: Object.freeze({}) });

export function createDevAuthorizer(principal: Principal = LOCAL_DEV_PRINCIPAL, opts: { evidenceTtlMs?: number } = {}): Authorizer {
  return {
    async authorize(req: AuthorizationRequest) {
      if (req.principal.tenantId !== principal.tenantId || req.principal.subjectId !== principal.subjectId) {
        return { decision: "deny", code: "ACCESS_DENIED", reason: `the development preset accepts only the local principal ${principal.tenantId}/${principal.subjectId}` };
      }
      return { decision: "allow", evidenceId: `dev:${req.runId}:${req.resource.type}:${req.resource.id}`, expiresAt: isoAfter(opts.evidenceTtlMs ?? 300_000) };
    },
  };
}
