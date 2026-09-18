import React, { useEffect, useMemo, useState, type FormEvent, type ReactElement } from "react";
import type { LlmDescribeResult, RedactedConnection } from "../../../../../src/shared/llm-api";
import { localizeError, t, type WorkbenchLocale } from "../i18n";
import { createWorkbenchLlmClient, newOperationId, type LlmUiClient, type LlmUiSpace } from "./client";
import { SpaceBindingPanel } from "./space-binding";

export type LlmModelCenterProps = {
  locale: WorkbenchLocale;
  writable: boolean;
  client: LlmUiClient;
  spaces: LlmUiSpace[];
  uuid: () => string;
  initialDescribe?: LlmDescribeResult;
};

type EditorMode = "closed" | "create" | "edit";
type WizardStep = 1 | 2 | 3 | 4;

const PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

function protocolLabel(api: unknown): string {
  return typeof api === "string" ? api : "";
}

function modelCount(connection: RedactedConnection): number {
  return Array.isArray(connection.providerConfig.models) ? connection.providerConfig.models.length : 0;
}

function modelIds(connection: RedactedConnection): string[] {
  if (!Array.isArray(connection.providerConfig.models)) return [];
  return connection.providerConfig.models.flatMap((item) =>
    item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : [],
  );
}

function endpointOf(connection: RedactedConnection): string {
  const url = connection.providerConfig.baseURL;
  return typeof url === "string" ? url : "";
}

function authLabel(locale: WorkbenchLocale, connection: RedactedConnection): string {
  if (connection.auth.kind === "none") return t(locale, "llm.authNone");
  return connection.auth.configured ? t(locale, "llm.authConfigured") : t(locale, "llm.authMissing");
}

function errorText(locale: WorkbenchLocale, error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return localizeError(locale, error as { code?: string; message?: string });
  }
  return localizeError(locale, error instanceof Error ? error.message : null);
}

export function LlmModelCenter({ locale, writable, client, spaces, uuid, initialDescribe }: LlmModelCenterProps): ReactElement {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(initialDescribe ? "ready" : "loading");
  const [error, setError] = useState<string | null>(null);
  const [describe, setDescribe] = useState<LlmDescribeResult | null>(initialDescribe ?? null);
  const [editor, setEditor] = useState<EditorMode>("closed");
  const [editing, setEditing] = useState<RedactedConnection | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    setStatus("loading");
    setError(null);
    try {
      setDescribe(await client.describe());
      setStatus("ready");
    } catch (caught) {
      setError(errorText(locale, caught));
      setStatus("error");
    }
  };

  useEffect(() => {
    void reload();
  }, [client]);

  const pending = describe?.pendingRestartSpaceIds ?? [];

  return (
    <section className="dsh-wb-llm" data-llm-center="true">
      <h3 className="dsh-wb-title">{t(locale, "settings.models")}</h3>
      <p className="dsh-wb-notice">{t(locale, "llm.scope")}</p>
      {pending.length > 0 && (
        <p className="dsh-wb-notice" data-llm-pending="true">
          {t(locale, "llm.savedPending", { count: String(pending.length) })}
        </p>
      )}
      {status === "loading" && <p role="status">{t(locale, "app.loading")}</p>}
      {error && (
        <p className="dsh-wb-alert" role="alert">
          {error}
        </p>
      )}
      {describe && editor === "closed" && deleteId === null && (
        <>
          <div className="dsh-wb-row">
            <button
              type="button"
              className="dsh-wb-btn primary"
              disabled={!writable}
              onClick={() => {
                setEditing(null);
                setEditor("create");
              }}
            >
              {t(locale, "llm.new")}
            </button>
            <button type="button" className="dsh-wb-btn" onClick={() => void reload()}>
              {t(locale, "app.retry")}
            </button>
          </div>
          {describe.connections.length === 0 ? (
            <p className="dsh-wb-muted">{t(locale, "llm.empty")}</p>
          ) : (
            <table className="dsh-wb-table" data-llm-list="true">
              <thead>
                <tr>
                  <th>{t(locale, "llm.displayName")}</th>
                  <th>{t(locale, "llm.protocol")}</th>
                  <th>{t(locale, "llm.endpoint")}</th>
                  <th>{t(locale, "llm.models")}</th>
                  <th>{t(locale, "llm.auth")}</th>
                  <th>{t(locale, "llm.usedBy")}</th>
                  <th>{t(locale, "llm.revision")}</th>
                </tr>
              </thead>
              <tbody>
                {describe.connections.map((connection) => (
                  <tr key={connection.id} data-connection-id={connection.id}>
                    <td>{connection.displayName}</td>
                    <td>
                      <code>{protocolLabel(connection.providerConfig.api)}</code>
                    </td>
                    <td>
                      <code>{endpointOf(connection)}</code>
                    </td>
                    <td>{modelCount(connection)}</td>
                    <td>{authLabel(locale, connection)}</td>
                    <td>{connection.usedBySpaceIds.join(", ") || t(locale, "plan.none")}</td>
                    <td>
                      {connection.revision}
                      {pending.some((id) => connection.usedBySpaceIds.includes(id))
                        ? ` · ${t(locale, "llm.pendingRestart")}`
                        : ""}
                    </td>
                    <td>
                      <div className="dsh-wb-actions">
                        <button
                          type="button"
                          className="dsh-wb-btn"
                          disabled={!writable}
                          onClick={() => {
                            setEditing(connection);
                            setEditor("edit");
                          }}
                        >
                          {t(locale, "llm.edit")}
                        </button>
                        <button
                          type="button"
                          className="dsh-wb-btn danger"
                          disabled={!writable}
                          onClick={() => setDeleteId(connection.id)}
                        >
                          {t(locale, "app.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <SpaceBindingPanel
            locale={locale}
            writable={writable}
            client={client}
            spaces={spaces}
            describe={describe}
            onChanged={() => void reload()}
          />
        </>
      )}
      {describe && editor !== "closed" && (
        <ConnectionEditor
          locale={locale}
          writable={writable}
          client={client}
          uuid={uuid}
          revision={describe.revision}
          existing={editing}
          mode={editor}
          onCancel={() => {
            setEditor("closed");
            setEditing(null);
          }}
          onSaved={() => {
            setEditor("closed");
            setEditing(null);
            void reload();
          }}
        />
      )}
      {describe && deleteId && (
        <DeletePanel
          locale={locale}
          writable={writable}
          client={client}
          connectionId={deleteId}
          revision={describe.revision}
          onClose={() => setDeleteId(null)}
          onDeleted={() => {
            setDeleteId(null);
            void reload();
          }}
        />
      )}
    </section>
  );
}

function ConnectionEditor({
  locale,
  writable,
  client,
  uuid,
  revision,
  existing,
  mode,
  onCancel,
  onSaved,
}: {
  locale: WorkbenchLocale;
  writable: boolean;
  client: LlmUiClient;
  uuid: () => string;
  revision: number;
  existing: RedactedConnection | null;
  mode: EditorMode;
  onCancel: () => void;
  onSaved: () => void;
}): ReactElement {
  const [step, setStep] = useState<WizardStep>(1);
  const [displayName, setDisplayName] = useState(existing?.displayName ?? "");
  const [api, setApi] = useState(
    typeof existing?.providerConfig.api === "string" ? existing.providerConfig.api : PROTOCOLS[0],
  );
  const [baseURL, setBaseURL] = useState(
    typeof existing?.providerConfig.baseURL === "string" ? existing.providerConfig.baseURL : "",
  );
  const [secret, setSecret] = useState("");
  const [models, setModels] = useState<string[]>(existing ? modelIds(existing) : []);
  const [manualModel, setManualModel] = useState("");
  const [discovered, setDiscovered] = useState<Array<{ id: string }>>([]);
  const [truncated, setTruncated] = useState(false);
  const [asDefault, setAsDefault] = useState(false);
  const [impact, setImpact] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const draftModels = useMemo(() => models.map((id) => ({ id })), [models]);
  const providerConfig = useMemo(
    () => ({
      ...(existing?.providerConfig ?? {}),
      api,
      baseURL,
      models: draftModels,
    }),
    [existing, api, baseURL, draftModels],
  );
  const secretDraft = { id: existing?.id, displayName, enabled: true, providerConfig };

  const previewEdit = async (): Promise<boolean> => {
    if (!existing) return true;
    try {
      const preview = await client.previewChange(
        { id: existing.id, displayName, enabled: existing.enabled, providerConfig },
        revision,
      );
      setImpact(preview.affectedSpaceIds);
      return true;
    } catch (caught) {
      setError(errorText(locale, caught));
      return false;
    }
  };

  const discover = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result =
        existing && !secret
          ? await client.discoverModels(existing.id)
          : await client.discoverDraft(secretDraft, secret);
      setDiscovered(result.models.map((row) => ({ id: row.id })));
      setTruncated(result.truncated);
      setNotice(t(locale, "llm.discoverNotTest"));
    } catch (caught) {
      setError(errorText(locale, caught));
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!writable) return;
    setBusy(true);
    setError(null);
    try {
      if (existing && !secret) {
        const catalog = await client.saveConnection(
          {
            id: existing.id,
            displayName,
            enabled: existing.enabled,
            providerConfig,
          },
          revision,
        );
        if (asDefault && models[0] && catalog.connectionId) {
          await client.setDefault({ connectionId: catalog.connectionId, modelId: models[0] }, catalog.revision);
        }
      } else {
        if (!secret) {
          setError(t(locale, "llm.draftNote"));
          setBusy(false);
          return;
        }
        const catalog = await client.saveConnectionWithCredential(
          secretDraft,
          secret,
          revision,
          newOperationId(uuid),
        );
        if (asDefault && models[0] && catalog.connectionId) {
          await client.setDefault({ connectionId: catalog.connectionId, modelId: models[0] }, catalog.revision);
        }
      }
      setSecret("");
      onSaved();
    } catch (caught) {
      setError(errorText(locale, caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="dsh-wb-llm-editor" onSubmit={(event) => void save(event)} data-llm-editor={mode}>
      <p className="dsh-wb-kicker">
        {t(locale, "llm.stepLabel", { step: String(step) })} · {t(locale, `llm.step${step}` as "llm.step1")}
      </p>
      {error && (
        <p className="dsh-wb-alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="dsh-wb-notice">{notice}</p>}
      {impact && impact.length > 0 && (
        <p className="dsh-wb-notice">
          {t(locale, "llm.impact")}: {impact.join(", ")}
        </p>
      )}
      {step === 1 && (
        <label className="dsh-wb-field">
          {t(locale, "llm.protocol")}
          <select value={api} onChange={(event) => setApi(event.target.value)} disabled={!writable}>
            {PROTOCOLS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      )}
      {step === 2 && (
        <>
          <label className="dsh-wb-field">
            {t(locale, "llm.displayName")}
            <input
              data-llm-field="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </label>
          <label className="dsh-wb-field">
            {t(locale, "llm.baseURL")}
            <input
              data-llm-field="baseURL"
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <label className="dsh-wb-field">
            {t(locale, "llm.apiKey")}
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="off"
              data-llm-secret="true"
            />
          </label>
          <p className="dsh-wb-muted">{t(locale, "llm.apiKeyHint")}</p>
          <p className="dsh-wb-muted">{t(locale, "llm.keylessUnsupported")}</p>
        </>
      )}
      {step === 3 && (
        <>
          <div className="dsh-wb-row">
            <input
              data-llm-field="modelId"
              value={manualModel}
              onChange={(event) => setManualModel(event.target.value)}
              placeholder={t(locale, "llm.modelId")}
            />
            <button
              type="button"
              className="dsh-wb-btn"
              onClick={() => {
                const id = manualModel.trim();
                if (!id || models.includes(id)) return;
                setModels([...models, id]);
                setManualModel("");
              }}
            >
              {t(locale, "llm.addModel")}
            </button>
            <button type="button" className="dsh-wb-btn" disabled={busy || (!secret && !existing)} onClick={() => void discover()}>
              {t(locale, "llm.discover")}
            </button>
          </div>
          <p className="dsh-wb-muted">{t(locale, "llm.discoverHint")}</p>
          {truncated && <p className="dsh-wb-notice">{t(locale, "llm.truncated")}</p>}
          <ul>
            {models.map((id) => (
              <li key={id}>
                <code>{id}</code>{" "}
                <button type="button" className="dsh-wb-btn" onClick={() => setModels(models.filter((item) => item !== id))}>
                  {t(locale, "app.delete")}
                </button>
              </li>
            ))}
          </ul>
          {discovered.length > 0 && (
            <div>
              <p>{t(locale, "llm.discovered")}</p>
              {discovered.map((row) => (
                <label key={row.id} className="dsh-wb-field">
                  <input
                    type="checkbox"
                    checked={models.includes(row.id)}
                    onChange={(event) => {
                      setModels(event.target.checked ? [...models, row.id] : models.filter((id) => id !== row.id));
                    }}
                  />
                  <code>{row.id}</code>
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {step === 4 && (
        <>
          <label className="dsh-wb-field">
            <input type="checkbox" checked={asDefault} onChange={(event) => setAsDefault(event.target.checked)} />
            {t(locale, "llm.setDefault")}
          </label>
          <p className="dsh-wb-muted">{t(locale, "llm.draftNote")}</p>
        </>
      )}
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn"
          onClick={() => {
            setSecret("");
            onCancel();
          }}
        >
          {t(locale, "llm.cancelDraft")}
        </button>
        {step > 1 && (
          <button type="button" className="dsh-wb-btn" onClick={() => setStep((step - 1) as WizardStep)}>
            {t(locale, "llm.back")}
          </button>
        )}
        {step < 4 && (
          <button
            type="button"
            className="dsh-wb-btn primary"
            onClick={() => {
              if (step === 2 && existing) void previewEdit();
              setStep((step + 1) as WizardStep);
            }}
          >
            {t(locale, "llm.next")}
          </button>
        )}
        {step === 4 && (
          <button type="submit" className="dsh-wb-btn primary" disabled={!writable || busy || !displayName || models.length === 0}>
            {t(locale, "app.save")}
          </button>
        )}
      </div>
    </form>
  );
}

function DeletePanel({
  locale,
  writable,
  client,
  connectionId,
  revision,
  onClose,
  onDeleted,
}: {
  locale: WorkbenchLocale;
  writable: boolean;
  client: LlmUiClient;
  connectionId: string;
  revision: number;
  onClose: () => void;
  onDeleted: () => void;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client
      .previewDelete(connectionId)
      .then((preview) => setRefs(preview.references.map((row) => `${row.spaceId} (${row.mode})`)))
      .catch((caught) => setError(errorText(locale, caught)));
  }, [client, connectionId, locale]);

  return (
    <div data-llm-delete={connectionId}>
      <h4>{t(locale, "llm.deleteTitle")}</h4>
      {error && (
        <p className="dsh-wb-alert" role="alert">
          {error}
        </p>
      )}
      {refs.length > 0 ? (
        <>
          <p className="dsh-wb-alert">{t(locale, "llm.deleteBlocked")}</p>
          <ul>
            {refs.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
          <p className="dsh-wb-muted">{t(locale, "llm.unbindFirst")}</p>
        </>
      ) : (
        <p>{t(locale, "llm.deleteConfirm")}</p>
      )}
      <div className="dsh-wb-actions">
        <button type="button" className="dsh-wb-btn" onClick={onClose}>
          {t(locale, "app.close")}
        </button>
        <button
          type="button"
          className="dsh-wb-btn danger"
          disabled={!writable || busy || refs.length > 0}
          onClick={() => {
            setBusy(true);
            void client
              .deleteConnection(connectionId, revision)
              .then(onDeleted)
              .catch((caught) => {
                setError(errorText(locale, caught));
                setBusy(false);
              });
          }}
        >
          {t(locale, "app.delete")}
        </button>
      </div>
    </div>
  );
}

export function workbenchLlmClient(api: Parameters<typeof createWorkbenchLlmClient>[0], uuid: () => string): LlmUiClient {
  return createWorkbenchLlmClient(api, uuid);
}
