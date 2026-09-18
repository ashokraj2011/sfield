/** Development preset contract (§4.3). Presets are installed packages resolved by name. */
import type { Principal } from "./common.js";
import type { MemoryRepository } from "./memory.js";
import type { ApprovalTransport, Authorizer, HostLimits, InputTransport, SFieldOptions, SecretResolver } from "./options.js";
import type { ArtifactStore, DeploymentMode, ExecutionPersistence } from "./persistence.js";
import type { RetrievalTypeFactory } from "./retrieval.js";

export interface PresetComponents {
  name: "local" | "memory";
  deployment: DeploymentMode;
  persistence: ExecutionPersistence;
  artifacts?: ArtifactStore;
  memory?: MemoryRepository;
  authorizer: Authorizer;
  approvals?: ApprovalTransport;
  input?: InputTransport;
  secrets?: SecretResolver;
  retrievalTypes?: RetrievalTypeFactory[];
  devPrincipal: Principal;
  limits?: HostLimits;
  /** Console banner text identifying the development setup (§4.3). */
  banner?: string;
  /** Component names the preset supplied, for `sfield doctor`. */
  components: Record<string, string>;
}

export interface PresetModule {
  createPreset(options: SFieldOptions & { configDir: string }): Promise<PresetComponents> | PresetComponents;
  /** Retrieval types available for validation without instantiating persistence. */
  retrievalTypes?: RetrievalTypeFactory[];
}
