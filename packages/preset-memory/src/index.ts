/** In-memory development preset (§4.3): the local assembly on ephemeral persistence, for tests. */
import type { PresetComponents, PresetModule, SFieldOptions, RetrievalTypeFactory } from "@sfield/core";
import { createDevAuthorizer, EnvSecretResolver, EphemeralPersistence, InMemoryArtifactStore, LOCAL_DEV_PRINCIPAL, SFieldError } from "@sfield/core";
import { cliApprovalTransport, cliInputTransport, defaultIo, localFilesRetrievalType, type CliIo } from "@sfield/preset-local";

export const retrievalTypes: RetrievalTypeFactory[] = [localFilesRetrievalType];

export interface MemoryPresetOptions extends SFieldOptions {
  configDir: string;
  io?: CliIo;
}

export function createPreset(options: MemoryPresetOptions): PresetComponents {
  const env = options.env ?? process.env;
  if (env["NODE_ENV"] === "production") throw new SFieldError("PRESET_REFUSED", 'the "memory" preset refuses to load under NODE_ENV=production');
  if (options.deployment === "service") throw new SFieldError("PRESET_REFUSED", 'the "memory" preset refuses to load with deployment: service');
  const io = options.io ?? defaultIo();
  const actor = { tenantId: LOCAL_DEV_PRINCIPAL.tenantId, subjectId: LOCAL_DEV_PRINCIPAL.subjectId };
  const persistence = new EphemeralPersistence();
  return {
    name: "memory",
    deployment: "ephemeral",
    persistence,
    artifacts: new InMemoryArtifactStore(),
    memory: persistence.memory,
    authorizer: createDevAuthorizer(LOCAL_DEV_PRINCIPAL),
    approvals: cliApprovalTransport(actor, io),
    input: cliInputTransport(actor, io),
    secrets: new EnvSecretResolver(env),
    retrievalTypes,
    devPrincipal: LOCAL_DEV_PRINCIPAL,
    limits: { grants: { interactionTools: ["ask_user", "memory.remember", "memory.forget"] } },
    banner: `[sfield] development preset "memory": in-memory persistence (state is lost on exit), CLI approvals, principal ${LOCAL_DEV_PRINCIPAL.tenantId}/${LOCAL_DEV_PRINCIPAL.subjectId}. Not for production.`,
    components: { persistence: "ephemeral (in-memory)", artifacts: "in-memory", memory: "in-memory", retrieval: "local_files", secrets: "environment variables", approvals: "cli", input: "cli", authorization: `local principal ${LOCAL_DEV_PRINCIPAL.tenantId}/${LOCAL_DEV_PRINCIPAL.subjectId}`, diagnostics: "console" },
  };
}

const presetModule: PresetModule = { createPreset, retrievalTypes };
export default presetModule;
