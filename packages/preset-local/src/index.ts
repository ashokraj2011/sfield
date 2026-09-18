/** Local development preset (§4.3): a complete development installation, self-identifying, refused in production. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PresetComponents, PresetModule, SFieldOptions, RetrievalTypeFactory } from "@sfield/core";
import { createDevAuthorizer, EnvSecretResolver, LOCAL_DEV_PRINCIPAL, SFieldError } from "@sfield/core";
import { sqlitePersistence } from "@sfield/store-sqlite";
import { fsArtifacts } from "@sfield/artifacts-fs";
import { localFilesRetrievalType } from "./local-files.js";
import { cliApprovalTransport, cliInputTransport, defaultIo, type CliIo } from "./cli-transports.js";

export { localFilesRetrievalType, LocalFilesBinding, tokenize } from "./local-files.js";
export { cliApprovalTransport, cliInputTransport, parseAnswer, defaultIo, type CliIo } from "./cli-transports.js";

export const retrievalTypes: RetrievalTypeFactory[] = [localFilesRetrievalType];

export interface LocalPresetOptions extends SFieldOptions {
  configDir: string;
  /** Directory for the SQLite file and artifacts; default `<configDir>/.sfield`. */
  dataDir?: string;
  io?: CliIo;
}

export function createPreset(options: LocalPresetOptions): PresetComponents {
  const env = options.env ?? process.env;
  if (env["NODE_ENV"] === "production") throw new SFieldError("PRESET_REFUSED", 'the "local" preset refuses to load under NODE_ENV=production');
  if (options.deployment === "service") throw new SFieldError("PRESET_REFUSED", 'the "local" preset refuses to load with deployment: service');
  const dataDir = resolve(options.dataDir ?? join(options.configDir, ".sfield"));
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "sfield.db");
  const artifactsDir = join(dataDir, "artifacts");
  const io = options.io ?? defaultIo();
  const actor = { tenantId: LOCAL_DEV_PRINCIPAL.tenantId, subjectId: LOCAL_DEV_PRINCIPAL.subjectId };
  const persistence = sqlitePersistence({ path: dbPath });
  return {
    name: "local",
    deployment: "durable_single",
    persistence,
    artifacts: fsArtifacts({ root: artifactsDir }),
    memory: persistence.memory,
    authorizer: createDevAuthorizer(LOCAL_DEV_PRINCIPAL),
    approvals: cliApprovalTransport(actor, io),
    input: cliInputTransport(actor, io),
    secrets: new EnvSecretResolver(env),
    retrievalTypes,
    devPrincipal: LOCAL_DEV_PRINCIPAL,
    limits: { grants: { interactionTools: ["ask_user", "memory.remember", "memory.forget"] } },
    banner: `[sfield] development preset "local": SQLite ${dbPath}, artifacts ${artifactsDir}, CLI approvals, principal ${LOCAL_DEV_PRINCIPAL.tenantId}/${LOCAL_DEV_PRINCIPAL.subjectId}. Not for production.`,
    components: {
      persistence: `@sfield/store-sqlite (${dbPath})`,
      artifacts: `@sfield/artifacts-fs (${artifactsDir})`,
      memory: "@sfield/store-sqlite memory repository",
      retrieval: "local_files",
      secrets: "environment variables",
      approvals: `cli (${io.interactive ? "interactive" : "non-interactive"})`,
      input: `cli (${io.interactive ? "interactive" : "non-interactive"})`,
      authorization: `local principal ${LOCAL_DEV_PRINCIPAL.tenantId}/${LOCAL_DEV_PRINCIPAL.subjectId}`,
      diagnostics: "console",
    },
  };
}

const presetModule: PresetModule = { createPreset, retrievalTypes };
export default presetModule;
