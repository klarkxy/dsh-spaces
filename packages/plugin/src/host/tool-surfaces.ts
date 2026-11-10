/**
 * Cordis / SDK structural surfaces shared by the main-host tool modules
 * (Creator tools and space-control tools). Kept local so this package pins no
 * dsh SDK version; version-matched at 0.2.2-rc.1.
 */
import type { Context } from "@deepseek-ai/cordis";

export interface ToolExecAgent {
  ctx: Context;
  session: { id?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ToolExec {
  signal: AbortSignal;
  agent?: ToolExecAgent;
  callId?: string;
  [key: string]: unknown;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
  originalDimensions?: { width: number; height: number };
}

export interface ImageBlock {
  type: "image";
  attachment: ImageAttachmentRef;
}

export type ContentBlock = TextBlock | ImageBlock;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  execute(args: Record<string, unknown>, exec: ToolExec): Promise<unknown>;
}

export interface ToolsService {
  register(definition: unknown): () => void;
}

export interface AgentPresetsService {
  composedPreset(ctx: Context): string | undefined;
}

export interface SandboxPolicyService {
  resolve(input: { session: unknown }): { mode: string };
}

export interface ApprovalService {
  request(req: {
    agent: object;
    toolName: string;
    callId?: string;
    reason: string;
    displayReason?: { en: string };
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface EscalationApprove {
  <A, C>(
    request: { requestedMode: string; effectiveMode: string; subject: string; justification: string },
    approval: {
      approver: ApprovalService | undefined;
      agent: A | undefined;
      callId: C;
      toolName: string;
      signal?: AbortSignal;
    },
  ): Promise<string>;
}
