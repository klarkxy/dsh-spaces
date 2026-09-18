import React, { useEffect, useState, type ReactElement } from "react";
import type {
  LlmDescribeResult,
  LlmImportedRequirementsResult,
  LlmLocalCandidate,
  LlmSpaceDefaultResult,
  LlmSpacePolicyResult,
  SharedSelection,
} from "../../../../../src/shared/llm-api";
import { localizeError, t, type WorkbenchLocale } from "../i18n";
import { newOperationId, type LlmUiClient, type LlmUiSpace } from "./client";

function errorText(locale: WorkbenchLocale, error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return localizeError(locale, error as { code?: string; message?: string });
  }
  return localizeError(locale, error instanceof Error ? error.message : null);
}

export function SpaceBindingPanel({
  locale,
  writable,
  client,
  spaces,
  describe,
  onChanged,
}: {
  locale: WorkbenchLocale;
  writable: boolean;
  client: LlmUiClient;
  spaces: LlmUiSpace[];
  describe: LlmDescribeResult;
  onChanged: () => void;
}): ReactElement {
  const [selected, setSelected] = useState(spaces[0]?.spaceId ?? "web");
  const [policy, setPolicy] = useState<LlmSpacePolicyResult | null>(null);
  const [defaults, setDefaults] = useState<LlmSpaceDefaultResult | null>(null);
  const [locals, setLocals] = useState<LlmLocalCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adoptSecret, setAdoptSecret] = useState("");
  const [adoptId, setAdoptId] = useState<string | null>(null);
  const [imported, setImported] = useState<LlmImportedRequirementsResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [applyIds, setApplyIds] = useState<string[]>(describe.pendingRestartSpaceIds);

  const load = async (spaceId: string): Promise<void> => {
    setError(null);
    try {
      const [nextPolicy, nextDefault, nextLocals, nextImported] = await Promise.all([
        client.spacePolicy(spaceId),
        client.spaceDefault(spaceId),
        client.listLocalCandidates(spaceId),
        client.importedRequirements(spaceId),
      ]);
      setPolicy(nextPolicy);
      setDefaults(nextDefault);
      setLocals(nextLocals.candidates);
      setImported(nextImported);
      setMapping({});
    } catch (caught) {
      setError(errorText(locale, caught));
    }
  };

  useEffect(() => {
    if (selected) void load(selected);
  }, [selected, client]);

  const mode = policy?.policy.shared.mode ?? "none";
  const selectedIds = policy?.policy.shared.mode === "selected" ? policy.policy.shared.connectionIds : [];

  const savePolicy = async (shared: SharedSelection): Promise<void> => {
    if (!policy) return;
    try {
      const next = await client.updateSpacePolicy(selected, shared, policy.policy.revision);
      setPolicy(next);
      onChanged();
    } catch (caught) {
      setError(errorText(locale, caught));
    }
  };

  return (
    <section className="dsh-wb-llm-spaces" data-llm-spaces="true">
      <h4>{t(locale, "llm.spacesTitle")}</h4>
      <p className="dsh-wb-muted">{t(locale, "llm.sharedReadonly")}</p>
      {error && (
        <p className="dsh-wb-alert" role="alert">
          {error}
        </p>
      )}
      <label className="dsh-wb-field">
        {t(locale, "home.spaces")}
        <select value={selected} onChange={(event) => setSelected(event.target.value)}>
          {spaces.map((space) => (
            <option key={space.spaceId} value={space.spaceId}>
              {space.displayName}
            </option>
          ))}
        </select>
      </label>
      {policy && (
        <>
          {policy.pendingRestart && <p className="dsh-wb-notice">{t(locale, "llm.pendingRestart")}</p>}
          <fieldset className="dsh-wb-field">
            <legend>{t(locale, "llm.sharedMode")}</legend>
            <label>
              <input
                type="radio"
                name="llm-mode"
                checked={mode === "all"}
                disabled={!writable}
                onChange={() => void savePolicy({ mode: "all" })}
              />
              {t(locale, "llm.modeAll")}
            </label>
            <p className="dsh-wb-muted">{t(locale, "llm.modeAllHint")}</p>
            <label>
              <input
                type="radio"
                name="llm-mode"
                checked={mode === "selected"}
                disabled={!writable}
                onChange={() => void savePolicy({ mode: "selected", connectionIds: selectedIds })}
              />
              {t(locale, "llm.modeSelected")}
            </label>
            <label>
              <input
                type="radio"
                name="llm-mode"
                checked={mode === "none"}
                disabled={!writable}
                onChange={() => void savePolicy({ mode: "none" })}
              />
              {t(locale, "llm.modeNone")}
            </label>
          </fieldset>
          {mode === "selected" && (
            <div>
              {describe.connections.map((connection) => (
                <label key={connection.id} className="dsh-wb-field">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(connection.id)}
                    disabled={!writable}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selectedIds, connection.id]
                        : selectedIds.filter((id) => id !== connection.id);
                      void savePolicy({ mode: "selected", connectionIds: next });
                    }}
                  />
                  {connection.displayName}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {defaults && (
        <fieldset className="dsh-wb-field">
          <legend>{t(locale, "llm.defaultModel")}</legend>
          <label>
            <input
              type="radio"
              name="llm-default"
              checked={defaults.inheritGlobal}
              disabled={!writable}
              onChange={() => {
                void client
                  .updateSpaceDefault(selected, null)
                  .then(setDefaults)
                  .catch((caught) => setError(errorText(locale, caught)));
              }}
            />
            {t(locale, "llm.inheritGlobal")}
          </label>
          <label>
            <input type="radio" name="llm-default" checked={!defaults.inheritGlobal} disabled={!writable} readOnly />
            {t(locale, "llm.chooseModel")}
          </label>
          <select
            value={
              defaults.local
                ? `${defaults.local.provider}::${defaults.local.model}`
                : defaults.global
                  ? `${defaults.global.connectionId}::${defaults.global.modelId}`
                  : ""
            }
            disabled={!writable}
            onChange={(event) => {
              const [connectionId, modelId] = event.target.value.split("::");
              if (!connectionId || !modelId) return;
              void client
                .updateSpaceDefault(selected, { connectionId, modelId })
                .then(setDefaults)
                .catch((caught) => setError(errorText(locale, caught)));
            }}
          >
            <option value="">{t(locale, "plan.none")}</option>
            {describe.connections.flatMap((connection) =>
              (Array.isArray(connection.providerConfig.models) ? connection.providerConfig.models : []).flatMap((item) => {
                if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") return [];
                return [
                  <option key={`${connection.id}:${item.id}`} value={`${connection.id}::${item.id}`}>
                    {t(locale, "llm.sharedGroup")} · {connection.displayName} / {item.id}
                  </option>,
                ];
              }),
            )}
          </select>
          {defaults.effective && (
            <p className="dsh-wb-muted">
              {defaults.effective.origin === "local" ? t(locale, "llm.chooseModel") : t(locale, "llm.inheritGlobal")}:{" "}
              <code>
                {defaults.effective.provider}/{defaults.effective.model}
              </code>
            </p>
          )}
        </fieldset>
      )}
      <div>
        <h5>{t(locale, "llm.mapTitle")}</h5>
        <p className="dsh-wb-muted">{t(locale, "llm.mapHint")}</p>
        {!imported?.mappingRequired || !imported.manifest ? (
          <p className="dsh-wb-muted">{t(locale, "llm.mapEmpty")}</p>
        ) : (
          <>
            {imported.manifest.requirements.map((requirement) => (
              <label key={requirement.requirementId} className="dsh-wb-field">
                {requirement.displayName} · {requirement.protocol} · {requirement.endpoint}
                <select
                  data-llm-map-select="true"
                  value={mapping[requirement.requirementId] ?? ""}
                  disabled={!writable}
                  onChange={(event) =>
                    setMapping((current) => ({ ...current, [requirement.requirementId]: event.target.value }))
                  }
                >
                  <option value="">{t(locale, "llm.mapNone")}</option>
                  {describe.connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <button
              type="button"
              className="dsh-wb-btn primary"
              data-llm-map-apply="true"
              disabled={!writable || !policy}
              onClick={() => {
                if (!policy || !imported.manifest) return;
                const mappings = imported.manifest.requirements.flatMap((requirement) => {
                  const connectionId = mapping[requirement.requirementId];
                  return connectionId ? [{ requirementId: requirement.requirementId, connectionId }] : [];
                });
                void client
                  .mapImported(selected, mappings, policy.policy.revision)
                  .then(() => load(selected).then(onChanged))
                  .catch((caught) => setError(errorText(locale, caught)));
              }}
            >
              {t(locale, "llm.mapApply")}
            </button>
          </>
        )}
      </div>
      <div>
        <h5>{t(locale, "llm.localGroup")}</h5>
        {locals.length === 0 ? <p className="dsh-wb-muted">{t(locale, "llm.localEmpty")}</p> : null}
        {locals.map((candidate) => (
          <div key={candidate.routeId} className="dsh-wb-space-row">
            <span>
              {candidate.displayName} · {candidate.api ?? ""} · {candidate.origin} · {candidate.modelIds.length}
            </span>
            <button
              type="button"
              className="dsh-wb-btn"
              disabled={!writable || candidate.credentialCopy === "unsupported"}
              onClick={() => {
                setAdoptId(candidate.routeId);
                if (candidate.credentialCopy === "available") {
                  void client
                    .adoptLocal(selected, candidate.routeId, candidate.displayName, describe.revision, true)
                    .then(() => {
                      setAdoptId(null);
                      onChanged();
                    })
                    .catch((caught) => setError(errorText(locale, caught)));
                }
              }}
            >
              {t(locale, "llm.adopt")}
            </button>
            {adoptId === candidate.routeId && candidate.credentialCopy !== "available" && (
              <label className="dsh-wb-field">
                {t(locale, "llm.adoptReenter")}
                <input type="password" value={adoptSecret} onChange={(event) => setAdoptSecret(event.target.value)} />
                <button
                  type="button"
                  className="dsh-wb-btn primary"
                  onClick={() => {
                    void client
                      .adoptLocalWithSecret(
                        selected,
                        candidate.routeId,
                        candidate.displayName,
                        adoptSecret,
                        describe.revision,
                        newOperationId(() => crypto.randomUUID()),
                      )
                      .then(() => {
                        setAdoptSecret("");
                        setAdoptId(null);
                        onChanged();
                      })
                      .catch((caught) => setError(errorText(locale, caught)));
                  }}
                >
                  {t(locale, "app.save")}
                </button>
              </label>
            )}
          </div>
        ))}
        <p className="dsh-wb-muted">{t(locale, "llm.adoptHint")}</p>
      </div>
      <div>
        <h5>{t(locale, "llm.apply")}</h5>
        <p className="dsh-wb-muted">{t(locale, "llm.applyHint")}</p>
        {spaces.map((space) => (
          <label key={space.spaceId} className="dsh-wb-field">
            <input
              type="checkbox"
              checked={applyIds.includes(space.spaceId)}
              onChange={(event) => {
                setApplyIds(
                  event.target.checked ? [...applyIds, space.spaceId] : applyIds.filter((id) => id !== space.spaceId),
                );
              }}
            />
            {space.displayName} ({space.status})
          </label>
        ))}
        <button
          type="button"
          className="dsh-wb-btn primary"
          disabled={!writable || applyIds.length === 0}
          onClick={() => {
            void Promise.all(applyIds.map((spaceId) => client.spacePolicy(spaceId)))
              .then((policies) => {
                const observations = applyIds.map((spaceId, index) => {
                  const space = spaces.find((row) => row.spaceId === spaceId);
                  return {
                    spaceId,
                    status: space?.status ?? "unknown",
                    generation: space?.generation ?? 0,
                    catalogRevision: policies[index]?.runningCatalogRevision ?? null,
                    busy: space?.status === "starting" || space?.status === "stopping",
                  };
                });
                return client.applyPlan(applyIds, describe.revision, observations, `apply-${Date.now()}`);
              })
              .then(onChanged)
              .catch((caught) => setError(errorText(locale, caught)));
          }}
        >
          {t(locale, "llm.apply")}
        </button>
      </div>
    </section>
  );
}
