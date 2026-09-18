import { Context } from "@deepseek-ai/cordis";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { LocalCredentialProvider } from "@deepseek-ai/dsh-credentials-local";
import {
  LLM_ERROR,
  LlmConfigError,
  parseManagedRecordKey,
} from "../../core/domain/llm-connections";
import type { LlmCredentialRecordInfo, LlmCredentialStore, LlmCredentialWrite } from "../../core/ports/llm-store";
import { llmControlDir, llmCredentialsPath } from "./llm-paths";

/**
 * Global secret store. Records are immutable and resolved by record id only.
 * Do not call official `resolve()` here — that path would inherit environment values.
 */
export class FileLlmCredentialStore implements LlmCredentialStore {
  constructor(private readonly home: string) {}

  async writeRecord(input: LlmCredentialWrite): Promise<LlmCredentialRecordInfo> {
    const key = managedCredentialKey(input.recordId);
    if (typeof input.secret !== "string" || input.secret.length === 0) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "credential secret must be a non-empty string");
    }
    return this.withProvider(async (provider) => {
      const existing = await provider.readRecord(key);
      if (existing) {
        throw new LlmConfigError(
          LLM_ERROR.CONFIG_INVALID,
          "credential records are immutable; write a new revision",
          { recordId: input.recordId },
        );
      }
      try {
        await provider.modifyRecord(key, async () => ({ kind: "api-key", key: input.secret }));
      } catch (error) {
        if (error instanceof LlmConfigError) throw error;
        throw new LlmConfigError(LLM_ERROR.CREDENTIAL_WRITE_FAILED, "official credential backend refused the write");
      }
      const written = await provider.readRecord(key);
      if (!written || written.kind !== "api-key" || written.key !== input.secret) {
        throw new LlmConfigError(LLM_ERROR.CREDENTIAL_WRITE_FAILED, "written credential record could not be verified", {
          recordId: input.recordId,
        });
      }
      return describeRecord(input.recordId, written);
    });
  }

  async readSecret(recordId: string): Promise<string | undefined> {
    const key = managedCredentialKey(recordId);
    return this.withProvider(async (provider) => {
      const record = await provider.readRecord(key);
      return record?.kind === "api-key" ? record.key : undefined;
    });
  }

  async describe(recordId: string): Promise<LlmCredentialRecordInfo> {
    const key = managedCredentialKey(recordId);
    return this.withProvider(async (provider) => {
      const record = await provider.readRecord(key);
      return describeRecord(recordId, record);
    });
  }

  private async withProvider<T>(fn: (provider: LocalCredentialProvider) => Promise<T>): Promise<T> {
    const ctx = new Context();
    await ctx.plugin(LocalCredentialProvider, {
      path: llmCredentialsPath(this.home),
      dshHome: llmControlDir(this.home),
      watch: false,
    });
    try {
      return await fn(ctx.credentials as LocalCredentialProvider);
    } finally {
      await ctx.fiber.dispose();
    }
  }
}

function managedCredentialKey(recordId: string) {
  if (!parseManagedRecordKey(recordId)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "credential record id is not a managed spaces-llm key", {
      recordId,
    });
  }
  const [scope, id] = recordId.split("/");
  return credentialKey(scope, id);
}

function describeRecord(
  recordId: string,
  record: { kind?: string; key?: string } | undefined,
): LlmCredentialRecordInfo {
  const configured = record?.kind === "api-key" && typeof record.key === "string" && record.key.length > 0;
  return {
    recordId,
    configured,
    writable: !configured,
    source: "spaces-global",
  };
}
