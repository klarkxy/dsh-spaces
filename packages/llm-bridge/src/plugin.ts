import { Context, type Fiber } from "@deepseek-ai/cordis";
import { installLlmActivity } from "./activity";

export const name = "dsh-spaces-llm-bridge";
export const inject = ["configEditor"];

const AGENT_DEFAULT_MODEL_NAMESPACE = "agent-default-model";

type ConfigEditorSeam = {
  configuration(): Array<{ entry: { options: { id: string } }; override?: Record<string, unknown> }>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasPersistedDefault(override: Record<string, unknown> | undefined): boolean {
  return (
    typeof override?.provider === "string" && override.provider.trim() !== "" &&
    typeof override?.model === "string" && override.model.trim() !== ""
  );
}

export function apply(ctx: Context, _config?: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const inheritMain = env.DSH_SPACES_LLM_INHERIT_MAIN === "1";
  const editor = (ctx as Context & { configEditor?: ConfigEditorSeam }).configEditor;
  ctx.on(
    "internal/config",
    function (this: Fiber | undefined, first: Fiber | undefined, next: () => unknown) {
      const fiber = this ?? first;
      const id = fiber?.entry?.options.id;
      if (id !== AGENT_DEFAULT_MODEL_NAMESPACE) return next();
      if (!inheritMain) return next();
      const override = editor?.configuration().find((row) => row.entry.options.id === id)?.override;
      if (hasPersistedDefault(override)) return next();
      return { ...asRecord(next()), provider: "spaces-main", model: "default" };
    },
    { global: true, prepend: true },
  );
  installLlmActivity(ctx, env);
}
