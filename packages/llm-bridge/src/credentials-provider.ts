import type { Context } from "@deepseek-ai/cordis";
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from "@deepseek-ai/dsh-credentials";
import type { LlmSharedSnapshot } from "../../../src/core/domain/llm-connections";
import { isManagedCredentialRef, parseManagedCredentialRef } from "../../../src/core/domain/llm-connections";
import { snapshotCredentialRef } from "../../../src/core/domain/llm-resolution";
import { missingSharedCredentialError, sharedReadOnlyError } from "./errors";

export const SHARED_CREDENTIAL_SOURCE = "spaces-global";

export interface SharedCredentialLookup {
  describe(recordId: string): Promise<{ configured: boolean }>;
  readSecret(recordId: string): Promise<string | undefined>;
}

export class SpacesCredentialsProvider extends CredentialProvider {
  private snapshot: LlmSharedSnapshot | null;

  constructor(
    ctx: Context,
    private readonly local: CredentialProvider,
    private readonly shared: SharedCredentialLookup,
    snapshot: LlmSharedSnapshot | null = null,
  ) {
    super(ctx);
    this.snapshot = snapshot;
  }

  replaceSharedSnapshot(snapshot: LlmSharedSnapshot | null): void {
    this.snapshot = snapshot;
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (!isManagedCredentialRef(ref)) return this.local.resolve(ref);
    const recordId = this.recordIdForRef(ref);
    if (!recordId) return undefined;
    const value = await this.shared.readSecret(recordId);
    if (!value) return undefined;
    return { value, source: SHARED_CREDENTIAL_SOURCE };
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (!isManagedCredentialRef(ref)) return this.local.describe(ref);
    const recordId = this.recordIdForRef(ref);
    if (!recordId) {
      return { configured: false, writable: false };
    }
    const info = await this.shared.describe(recordId);
    return {
      configured: info.configured,
      source: info.configured ? SHARED_CREDENTIAL_SOURCE : undefined,
      writable: false,
    };
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (isManagedCredentialRef(ref)) throw sharedReadOnlyError(ref);
    return this.local.set(ref, value);
  }

  override async unset(ref: CredentialRef): Promise<void> {
    if (isManagedCredentialRef(ref)) throw sharedReadOnlyError(ref);
    return this.local.unset(ref);
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    this.assertLocalRecord(key);
    return this.local.readRecord(key);
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    if (String(key).startsWith("spaces-llm/")) {
      return { configured: false, writable: false };
    }
    return this.local.describeRecord(key);
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return this.local.listRecords();
  }

  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.assertLocalRecord(key);
    return this.local.modifyRecord(key, mutate);
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    this.assertLocalRecord(key);
    return this.local.deleteRecord(key);
  }

  requireManagedResolve(ref: string): void {
    if (!isManagedCredentialRef(ref)) return;
    if (!this.recordIdForRef(ref)) throw missingSharedCredentialError(ref);
  }

  private recordIdForRef(ref: string): string | null {
    const parsed = parseManagedCredentialRef(ref);
    if (!parsed || !this.snapshot) return null;
    const connection = this.snapshot.connections.find((item) => item.id === parsed.connectionId);
    if (!connection || connection.auth.kind !== "api-key") return null;
    const expected = snapshotCredentialRef(connection);
    return expected === ref ? connection.auth.credentialRecordId : null;
  }

  private assertLocalRecord(key: CredentialKey): void {
    if (String(key).startsWith("spaces-llm/")) throw sharedReadOnlyError(String(key));
  }
}
