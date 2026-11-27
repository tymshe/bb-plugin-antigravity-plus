import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ANTIGRAVITY_ACP_DIALECT_ID } from "./dialect.ts";
import { emptySwarmBoardSnapshot, swarmHostContract, swarmRpcContract } from "./swarm-contract.ts";
import { registerAntigravityUsageSource } from "./usage.ts";

export { swarmRpcContract };

const PROVIDER_ID = "antigravity-plus";
const MAX_THREAD_IDENTITY_CACHE = 256;

const launchSpec = {
  displayName: "Antigravity Provider +",
  command: "agy",
  args: ["acp", "--disable-telemetry"],
  env: {},
};

interface CachedThreadTarget {
  providerThreadId: string;
  hostId: string;
}

export default async function antigravity(bb: BbPluginApi) {
  registerAntigravityUsageSource(bb);

  if (bb.hosts?.experimental_client && bb.rpc?.register) {
    const hostClient = bb.hosts.experimental_client({ contract: swarmHostContract });
    const threadIdentityCache = new Map<string, CachedThreadTarget>();
    let threadEventsRevision = 0;

    function invalidateThreadTarget(threadId: string): void {
      threadEventsRevision += 1;
      threadIdentityCache.delete(threadId);
    }

    function rememberThreadTarget(threadId: string, target: CachedThreadTarget): void {
      if (threadIdentityCache.size >= MAX_THREAD_IDENTITY_CACHE) {
        const oldest = threadIdentityCache.keys().next().value;
        if (oldest) threadIdentityCache.delete(oldest);
      }
      threadIdentityCache.set(threadId, target);
    }

    async function resolveThreadTarget(
      threadId: string,
      signal: AbortSignal,
    ): Promise<CachedThreadTarget | null> {
      const cached = threadIdentityCache.get(threadId);
      if (cached) return cached;

      const revision = threadEventsRevision;
      let detail: any;
      try {
        detail = await bb.sdk.threads.get({ threadId, include: "environment", signal });
      } catch {
        return null;
      }

      const thread = detail?.thread ?? detail;
      if (!thread || thread.providerId !== PROVIDER_ID) {
        return null;
      }

      let hostId: string | null =
        typeof detail?.environment?.hostId === "string" && detail.environment.hostId.length > 0
          ? detail.environment.hostId
          : null;

      if (!hostId && typeof thread.environmentId === "string" && thread.environmentId.length > 0) {
        try {
          const envDetail: any = await bb.sdk.environments.get({
            environmentId: thread.environmentId,
            signal,
          });
          const envObj = envDetail?.environment ?? envDetail;
          if (typeof envObj?.hostId === "string" && envObj.hostId.length > 0) {
            hostId = envObj.hostId;
          }
        } catch {
          return null;
        }
      }

      if (!hostId) return null;

      let providerThreadId: string | null = null;
      try {
        const identityEvents = await bb.sdk.threads.events.list({
          threadId,
          types: ["thread/identity"],
          order: "desc",
          limit: "1",
          signal,
        });
        const first = identityEvents[0] as { data?: { providerThreadId?: unknown } } | undefined;
        if (typeof first?.data?.providerThreadId === "string" && first.data.providerThreadId.length > 0) {
          providerThreadId = first.data.providerThreadId;
        }
      } catch {
        return null;
      }

      if (!providerThreadId) return null;
      const target = { providerThreadId, hostId };
      if (revision === threadEventsRevision) rememberThreadTarget(threadId, target);
      return target;
    }

    bb.rpc.register(swarmRpcContract, {
      async getSwarmBoard({ threadId }, context) {
        const target = await resolveThreadTarget(threadId, context.experimental_signal);
        if (!target) return emptySwarmBoardSnapshot(null);
        try {
          return await hostClient.call(
            "readSwarmBoard",
            { providerThreadId: target.providerThreadId },
            { hostId: target.hostId, signal: context.experimental_signal },
          );
        } catch (error) {
          bb.log?.debug?.(
            `readSwarmBoard failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return emptySwarmBoardSnapshot(target.providerThreadId);
        }
      },
    });

    bb.events?.on?.("experimental_thread.events", ({ thread }) => {
      if (thread.providerId === PROVIDER_ID) {
        // The SDK event carries a sequence counter, not the individual event types.
        invalidateThreadTarget(thread.id);
        bb.rpc.experimental_invalidate([`swarm:${thread.id}`]);
      }
    });
    bb.events?.on?.("thread.deleted", ({ thread }) => {
      invalidateThreadTarget(thread.id);
    });
    bb.onDispose?.(() => {
      threadEventsRevision += 1;
      threadIdentityCache.clear();
    });
  }

  bb.settings.define({
    autoOpenSwarmBoard: {
      type: "boolean",
      label: "Auto-open the Swarm tab when a swarm starts",
      description: "Open the Swarm side-panel tab once when /swarm starts on a thread. Does not reopen if you close it or revisit older threads.",
      default: true,
    },
    commandDescriptionsEnabled: {
      type: "boolean",
      label: "Show plain-English command summaries",
      description: "Use Antigravity's short description as each command card's title and show the raw shell command underneath.",
      default: true,
    },
    subagentsDisabled: {
      type: "boolean",
      label: "Use BB child threads instead of CLI subagents",
      description: "Disable Antigravity's built-in subagent tools so agents delegate through visible BB child threads instead. Does not affect /swarm.",
      default: false,
    },
    acceptEditsApproval: {
      type: "select",
      label: "Accept edits approval policy",
      description: "Choose how Antigravity tool and command prompts are handled on new turns in Accept edits mode. Full access always approves all requests.",
      options: ["ask", "auto-in-sandbox", "auto-all"],
      experimental_optionLabels: {
        ask: "Ask for each request",
        "auto-in-sandbox": "Auto-approve in sandbox, ask on escape",
        "auto-all": "Auto-approve all requests",
      },
      default: "ask",
    },
    sandbox: {
      type: "boolean",
      label: "Force CLI terminal sandbox on new threads",
      description: "Pass --sandbox to agy on new threads instead of inheriting your CLI default. Requires a supported OS; Full access can still approve commands outside the sandbox.",
      default: false,
    },
  });
  bb.providers.register({
    id: PROVIDER_ID,
    displayName: "Antigravity Provider +",
    icon: "./assets/provider.svg",
    family: "antigravity",
    strings: {
      signInHint: "Run `agy acp --login` on this machine, then retry.",
      expiredHint: "Run `agy acp --login` on this machine to refresh your sign-in.",
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      planModeCopy: "Antigravity will research and plan before editing files.",
    },
    experimental_bridgeOptions: {
      acpLaunchSpec: launchSpec,
      acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
    },
    deriveProviderOptions({ settings }) {
      const approval = settings.acceptEditsApproval;
      const autoApprove = approval === "auto-in-sandbox" || approval === "auto-all";
      const promptOnSandboxEscape = approval !== "auto-all";
      return {
        autoApprove,
        promptOnSandboxEscape,
        providerSubagentsEnabled: settings.subagentsDisabled !== true,
        commandDescriptionsEnabled: settings.commandDescriptionsEnabled !== false,
        acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
        acpLaunchSpec: {
          ...launchSpec,
          args: [
            ...launchSpec.args,
            "--process-per-session",
            ...(settings.sandbox === true ? ["--sandbox"] : []),
          ],
        },
      };
    },
    experimental_nativeSkillRoots: {
      user: [
        ".gemini/antigravity-cli/skills",
        ".gemini/skills",
        ".gemini/config/skills",
        ".agents/skills",
      ],
      project: [
        { path: ".agents/skills", ancestors: true },
        ".agent/skills",
      ],
    },
    experimental_visibility: "always",
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "tip",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    composerActions: ["plan"],
    models: { fallback: [], scope: "host" },
    env: {
      passthrough: [
        "BB_ANTIGRAVITY_GEMINI_DIR",
        "BB_ANTIGRAVITY_APP_DATA_DIR",
        "BB_AGY_ACP_PROXY",
        "AGY_CLI_AUTO_COMPACT_OVERRIDE",
      ],
    },
  });
}
