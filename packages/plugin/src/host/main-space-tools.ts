/**
 * Creator host tools of the trusted main host (web/desktop). They call the
 * management service under a Creator-scoped registration, never the raw
 * WorkbenchApi. No arbitrary shell or management command is exposed.
 *
 * The wire DTOs are owned by `src/shared/creator.ts`; this module only adds
 * the model-facing tool definitions, the Creator preset gate and the native
 * escalation gate of the execute call.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  CreatorContext,
  CreatorPlan,
  CreatorPluginSpec,
  CreatorModelSource,
} from "../../../../src/shared/creator";
import type { WorkbenchJob } from "../../../../src/shared/workbench";
import type { WorkbenchHostRuntime } from "./runtime";
import type { MainSpaceCreatorService } from "./main-space-creator";

/** Preview request: the user-facing creation input before server normalization. */
export interface CreatorCreatePreviewInput {
  name: string;
  displayName?: string;
  icon?: string;
  baseVersion?: string;
  modelSource?: CreatorModelSource;
  startAfterCreate?: boolean;
  plugins?: CreatorPluginSpec[];
}

// Cordis / SDK structural surfaces live in ./tool-surfaces (shared with
// space-control). Creator-specific names are aliases of the shared shapes.

import {
  AgentPresetsService,
  ApprovalService,
  EscalationApprove,
  SandboxPolicyService,
  ToolDefinition,
  ToolExec,
  ToolsService,
} from "./tool-surfaces";

type CreatorToolExec = ToolExec;

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const CREATOR_PRESET = "cordis";

function creatorError(message: string): Error {
  const error = new Error(message);
  error.name = "CreatorToolError";
  return error;
}

function requireCreatorPreset(ctx: { agentPresets?: AgentPresetsService }, exec: CreatorToolExec): void {
  const presets = ctx.agentPresets;
  if (!exec.agent || !presets || presets.composedPreset(exec.agent.ctx) !== CREATOR_PRESET) {
    throw creatorError("Creating a space requires Creator mode.");
  }
}

const OUTPUT: ToolDefinition["output"] = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

function parameters(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    required: Object.keys(properties),
  };
}

/** Reject keys the closed parameter object did not declare. */
function closedArgs(args: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw creatorError(`${label}: unknown field "${key}".`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw creatorError(`${label} is required.`);
  return value;
}

// ---------------------------------------------------------------------------
// Escalation (native approveEscalation shape, dynamically imported).
// ---------------------------------------------------------------------------

export type { EscalationApprove } from "./tool-surfaces";

export interface MainSpaceToolsOptions {
  /** Escalation gate override for tests; defaults to the official dsh-sandbox approveEscalation. */
  approve?: EscalationApprove;
}

/**
 * The single approval of an execute call. It names the target space, every
 * exact plugin source and every install script the plan will run, because the
 * plan — not this tool — is the authorization object.
 */
async function approveCreate(
  ctx: { sandboxPolicy?: SandboxPolicyService; get(name: string, strict?: boolean): unknown },
  exec: CreatorToolExec,
  plan: CreatorPlan,
  approve?: EscalationApprove,
): Promise<void> {
  const policy = ctx.sandboxPolicy?.resolve({ session: exec.agent!.session });
  approve ??= ((await import("@deepseek-ai/dsh-sandbox")) as { approveEscalation: EscalationApprove }).approveEscalation;
  const packages = plan.input.plugins.map((plugin) =>
    plugin.kind === "npm"
      ? `${plugin.packageName}@${plugin.version}`
      : `github:${plugin.owner}/${plugin.repo}@${plugin.commit}${plugin.path ? ` path ${plugin.path}` : ""}`);
  const builds = plan.input.plugins.flatMap((plugin) => plugin.approvedBuilds);
  const reason = [
    `Create space "${plan.input.displayName ?? plan.input.name}"`,
    `base ${plan.input.baseVersion ?? "host runtime"}`,
    `model ${plan.input.modelSource}`,
    packages.length ? `installing plugins ${packages.join(", ")}` : "with no extra plugins",
    plan.input.startAfterCreate ? "then start it" : "without starting it",
    builds.length
      ? `persisting allowBuilds for ${builds.join(", ")} in the new profile's install permissions`
      : "without allowing install scripts",
  ].join(", ") + ".";
  await approve(
    { requestedMode: "danger-full-access", effectiveMode: policy?.mode ?? "read-only", subject: "space creation", justification: reason },
    {
      approver: ctx.get("approval", false) as ApprovalService | undefined,
      agent: exec.agent,
      callId: exec.callId,
      toolName: "spaces_create_execute",
      signal: exec.signal,
    },
  );
  exec.signal.throwIfAborted();
}

// ---------------------------------------------------------------------------
// Tool installation
// ---------------------------------------------------------------------------

/**
 * Register the Creator tools on a confirmed trusted main host. Registration is
 * an effect of the given fiber: the tools disappear with the host. The tools
 * require `tools`, `agentPresets`, `sandboxPolicy` and `profileContext`; the
 * LLM services are not part of this contract, so a host without them still
 * serves the tools.
 */
export function installMainSpaceTools(
  ctx: Context,
  runtime: WorkbenchHostRuntime,
  creator: MainSpaceCreatorService | null,
  options: MainSpaceToolsOptions = {},
): void {
  if (!runtime.isTrustedMainHost || !creator) return;
  const target = ctx as Context & {
    inject?: (deps: string[], callback: (ctx: Context) => void) => unknown;
  };
  if (typeof target.inject !== "function") return;
  target.inject(["tools", "agentPresets", "sandboxPolicy", "profileContext"], (scope) => {
    const scoped = scope as Context & {
      tools: ToolsService;
      agentPresets: AgentPresetsService;
      sandboxPolicy: SandboxPolicyService;
      get(name: string, strict?: boolean): unknown;
    };

    const register = (definition: ToolDefinition): void => {
      scope.effect(() => scoped.tools.register(definition), `dsh-spaces.${definition.name}`);
    };

    register({
      name: "spaces_context",
      description:
        "Creator only: read the Spaces management context for this main host — service epoch, revision, writability, maintenance, busy creation and available model sources. No credentials and no paths are returned.",
      parameters: parameters({}),
      output: OUTPUT,
      async execute(args, exec): Promise<CreatorContext> {
        closedArgs(args, [], "spaces_context");
        requireCreatorPreset(scoped, exec);
        return creator.context(exec.signal);
      },
    });

    register({
      name: "spaces_create_preview",
      description:
        "Creator only: freeze a space creation plan server-side. Returns the plan id, fingerprint, normalized input and the exact step list; nothing is installed or changed. Execution needs the plan id and one approval.",
      parameters: parameters({
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", description: "Space id segment; the space id becomes space-<name>." },
            displayName: { type: "string", description: "Optional display name." },
            icon: { type: "string", description: "Optional icon spec." },
            baseVersion: { type: "string", description: "Exact DSH base version; omit for the host CLI version." },
            modelSource: { type: "string", enum: ["main", "local"], description: "Model source: copy the main space model configuration once at creation (main) or configure models in the space (local). Default main." },
            startAfterCreate: { type: "boolean", description: "Start the space after creation. Default false." },
            plugins: {
              type: "array",
              description: "Plugins to install into the new space. Each entry is exactly one of npm or github with an exact pinned source.",
              items: {
                oneOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      npm: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          packageName: { type: "string", description: "npm package name." },
                          version: { type: "string", description: "Exact published version; no tag or range." },
                          approvedBuilds: {
                            type: "array",
                            items: { type: "string" },
                            description: "Exact pnpm allowBuilds keys whose install-time build scripts are persisted for the new profile: package name or name@version only, never URLs or wildcards. Never silently allow scripts.",
                          },
                        },
                        required: ["packageName", "version"],
                      },
                    },
                    required: ["npm"],
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      github: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          owner: { type: "string", description: "Repository owner." },
                          repo: { type: "string", description: "Repository name." },
                          commit: { type: "string", description: "Full 40-char commit sha; no branch or tag." },
                          path: { type: "string", description: "Optional package subdirectory inside the repository." },
                          packageName: { type: "string", description: "Expected installed package.json name." },
                          approvedBuilds: {
                            type: "array",
                            items: { type: "string" },
                            description: "Exact pnpm allowBuilds keys whose install-time build scripts are persisted for the new profile: package name or name@version only, never URLs or wildcards. Never silently allow scripts.",
                          },
                        },
                        required: ["owner", "repo", "commit", "packageName"],
                      },
                    },
                    required: ["github"],
                  },
                ],
              },
            },
          },
          required: ["name"],
        },
      }),
      output: OUTPUT,
      async execute(args, exec): Promise<CreatorPlan> {
        closedArgs(args, ["input"], "spaces_create_preview");
        requireCreatorPreset(scoped, exec);
        const input = args.input;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw creatorError("spaces_create_preview: input is required.");
        }
        return creator.createPreview(input as CreatorCreatePreviewInput, exec.signal);
      },
    });

    register({
      name: "spaces_create_execute",
      description:
        "Creator only: execute the exact frozen plan returned by spaces_create_preview under this main host's registration. Requires Creator mode plus danger-full-access permission or approval; the approval shows the target space, exact plugin sources and every install script persisted as the new profile's allowBuilds. A changed or expired plan must be previewed again.",
      parameters: parameters({
        planId: { type: "string" },
        requestId: { type: "string" },
      }),
      output: OUTPUT,
      async execute(args, exec): Promise<WorkbenchJob> {
        closedArgs(args, ["planId", "requestId"], "spaces_create_execute");
        requireCreatorPreset(scoped, exec);
        const planId = requiredString(args.planId, "spaces_create_execute: planId");
        const requestId = requiredString(args.requestId, "spaces_create_execute: requestId");
        // The approved object is the plan this main host previewed under its
        // current registration, not just an id.
        const plan = creator.previewedPlan(planId);
        if (!plan) {
          throw creatorError("The creation plan must be previewed again under this main host's registration before it can be executed.");
        }
        await approveCreate(scoped, exec, plan, options.approve);
        return creator.createExecute({ planId, requestId }, exec.signal);
      },
    });

    register({
      name: "spaces_job",
      description:
        "Creator only: read one creation job by id, scoped to this host's Creator registration. No credentials are returned.",
      parameters: parameters({
        jobId: { type: "string" },
      }),
      output: OUTPUT,
      async execute(args, exec): Promise<WorkbenchJob> {
        closedArgs(args, ["jobId"], "spaces_job");
        requireCreatorPreset(scoped, exec);
        const jobId = requiredString(args.jobId, "spaces_job: jobId");
        return creator.job(jobId, exec.signal);
      },
    });
  });
}
