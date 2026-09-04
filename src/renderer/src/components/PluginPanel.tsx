import { useEffect, useMemo, useState } from "react";
import type {
  InstalledPlugin,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginTier,
  ProfileRecord,
} from "@shared/types";
import { isInstallableEntry } from "@shared/plugin";
import { useI18n } from "../i18n";

const MAX_SHOWN = 80;

type Filter = "installable" | "all";

function blurb(entry: PluginCatalogEntry, locale: string): string {
  if (locale === "zh") return entry.summary || entry.summaryEn || entry.description;
  return entry.summaryEn || entry.summary || entry.description;
}

function tierKey(
  tier: PluginTier,
): "plugins.tierVerifiedNpm" | "plugins.tierVerifiedGit" | "plugins.tierLikely" | "plugins.tierRelated" {
  if (tier === "verified-npm") return "plugins.tierVerifiedNpm";
  if (tier === "verified-git") return "plugins.tierVerifiedGit";
  if (tier === "likely-plugin") return "plugins.tierLikely";
  return "plugins.tierRelated";
}

function othersWith(
  installed: Record<string, InstalledPlugin[]>,
  packageName: string,
  current: string,
): string[] {
  return Object.entries(installed)
    .filter(
      ([name, list]) => name !== current && list.some((item) => item.name === packageName),
    )
    .map(([name]) => name);
}

export function PluginPanel({
  profiles,
  selected,
  catalogUrl,
  onCatalogUrl,
  onRestart,
}: {
  profiles: ProfileRecord[];
  selected: string | null;
  catalogUrl: string;
  onCatalogUrl: (url: string) => void;
  onRestart: (name: string) => void;
}) {
  const { t, locale } = useI18n();
  const fallback = selected && profiles.some((item) => item.name === selected)
    ? selected
    : (profiles[0]?.name ?? "");
  const [space, setSpace] = useState(fallback);
  const [spec, setSpec] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("installable");
  const [catalog, setCatalog] = useState<PluginCatalogSnapshot | null>(null);
  const [installed, setInstalled] = useState<Record<string, InstalledPlugin[]>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [restart, setRestart] = useState<string[]>([]);
  const [copying, setCopying] = useState<string | null>(null);
  const [copyTargets, setCopyTargets] = useState<string[]>([]);

  useEffect(() => {
    if (selected && profiles.some((item) => item.name === selected)) {
      setSpace(selected);
    }
  }, [selected, profiles]);

  const refreshInstalled = async () => {
    try {
      setInstalled(await window.dshSpaces.listAllProfilePlugins());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadCatalog = async (refresh = false) => {
    setBusy(t("busy.refreshCatalog"));
    setError("");
    try {
      setCatalog(await window.dshSpaces.getPluginCatalog({ refresh, url: catalogUrl }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    void refreshInstalled();
    void loadCatalog(false);
  }, []);

  const currentList = installed[space] ?? [];
  const here = new Set(currentList.map((item) => item.name));

  const matches = useMemo(() => {
    const entries = catalog?.entries ?? [];
    const q = query.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (filter === "installable" && !isInstallableEntry(entry)) return false;
      if (!q) return true;
      const hay = [
        entry.id,
        entry.repo,
        entry.packageName,
        entry.summary,
        entry.summaryEn,
        entry.description,
        ...entry.tags,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    filtered.sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
    return filtered;
  }, [catalog, query, filter]);

  const shown = matches.slice(0, MAX_SHOWN);
  const sourceLabel =
    catalog?.source === "remote"
      ? t("plugins.sourceRemote")
      : catalog?.source === "cache"
        ? t("plugins.sourceCache")
        : catalog
          ? t("plugins.sourceSeed")
          : "";

  const run = async (label: string, action: () => Promise<{ running: string[] } | void>) => {
    setBusy(label);
    setError("");
    try {
      const result = await action();
      await refreshInstalled();
      if (result && result.running.length > 0) setRestart(result.running);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const extraInstalled = currentList.filter((item) => !item.protected);
  const otherSpaces = profiles.filter((item) => item.name !== space);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      <label className="text-xs" style={{ color: "var(--text-label)" }}>
        {t("plugins.space")}
        <select className="field mt-1" value={space} onChange={(event) => setSpace(event.target.value)}>
          {profiles.map((profile) => (
            <option key={profile.name} value={profile.name}>
              {profile.meta.displayName}
              {profile.name === "web" && profile.meta.displayName !== "web" ? " (web)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs" style={{ color: "var(--text-faint)" }}>
        {t("plugins.spaceHint")}
      </p>

      <div className="min-h-0 flex-[1.2] overflow-y-auto rounded-lg p-3" style={{ border: "1px solid var(--border)" }}>
        <p className="text-xs font-medium" style={{ color: "var(--text-label)" }}>
          {t("plugins.installedTitle")}
        </p>
        {currentList.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--text-faint)" }}>
            {t("plugins.emptyInstalled")}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {currentList.map((item) => {
              const also = othersWith(installed, item.name, space);
              const alsoLabels = also.map(
                (name) => profiles.find((profile) => profile.name === name)?.meta.displayName || name,
              );
              const copyCandidates = otherSpaces.filter((profile) => !also.includes(profile.name));
              return (
                <li key={item.name} className="text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {item.name}
                        {item.version ? ` @ ${item.version}` : ""}
                      </p>
                      {also.length > 0 ? (
                        <p className="mt-0.5 text-xs" style={{ color: "var(--text-faint)" }}>
                          {t("plugins.alsoOn", { names: alsoLabels.join(", ") })}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {item.protected ? (
                        <span className="text-xs" style={{ color: "var(--text-faint)" }}>
                          {t("plugins.locked")}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="text-xs"
                          style={{ color: "var(--danger)" }}
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void run(t("busy.removePlugin"), () =>
                              window.dshSpaces.removePlugin(space, item.name),
                            )
                          }
                        >
                          {t("plugins.remove")}
                        </button>
                      )}
                      {!item.protected && copyCandidates.length > 0 ? (
                        <button
                          type="button"
                          className="text-xs"
                          style={{ color: "var(--text-muted)" }}
                          onClick={() => {
                            setCopying(copying === item.name ? null : item.name);
                            setCopyTargets([]);
                          }}
                        >
                          {t("plugins.copyTo")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {copying === item.name ? (
                    <div className="mt-2 flex flex-col gap-1">
                      {copyCandidates.map((profile) => (
                        <label key={profile.name} className="flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={copyTargets.includes(profile.name)}
                            onChange={() =>
                              setCopyTargets((current) =>
                                current.includes(profile.name)
                                  ? current.filter((name) => name !== profile.name)
                                  : [...current, profile.name],
                              )
                            }
                          />
                          {profile.meta.displayName}
                        </label>
                      ))}
                      <button
                        type="button"
                        className="mt-1 self-start rounded px-2 py-1 text-xs text-white"
                        style={{ background: "var(--accent)" }}
                        disabled={Boolean(busy) || copyTargets.length === 0}
                        onClick={() =>
                          void run(t("busy.installPlugin"), () =>
                            window.dshSpaces.installPlugin({
                              profiles: copyTargets,
                              spec: item.name,
                            }),
                          ).then(() => {
                            setCopying(null);
                            setCopyTargets([]);
                          })
                        }
                      >
                        {t("plugins.copyConfirm")}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {extraInstalled.length === 0 && currentList.length > 0 ? (
          <p className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>
            {t("plugins.emptyInstalled")}
          </p>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <p className="text-xs font-medium" style={{ color: "var(--text-label)" }}>
          {t("plugins.addToSpace")}
        </p>
        <div className="flex gap-2">
          <input
            className="field flex-1"
            placeholder={t("plugins.specHint")}
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
            aria-label={t("plugins.spec")}
          />
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-white"
            style={{ background: "var(--accent)" }}
            disabled={Boolean(busy) || !space || !spec.trim()}
            onClick={() =>
              void run(t("busy.installPlugin"), () =>
                window.dshSpaces.installPlugin({ profiles: [space], spec: spec.trim() }),
              )
            }
          >
            {t("plugins.install")}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            className="field min-w-[180px] flex-1"
            placeholder={t("plugins.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="field w-auto shrink-0"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
            aria-label={t("plugins.filter")}
          >
            <option value="installable">{t("plugins.filterInstallable")}</option>
            <option value="all">{t("plugins.filterAll")}</option>
          </select>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}
            disabled={Boolean(busy)}
            onClick={() => void loadCatalog(true)}
          >
            {t("plugins.refresh")}
          </button>
        </div>
        <p className="text-xs" style={{ color: "var(--text-faint)" }}>
          {sourceLabel}
          {catalog ? ` · ${t("plugins.showing", { shown: shown.length, total: matches.length })}` : ""}
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {shown.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>
              {!catalog && (busy || !error) ? t("plugins.loading") : t("plugins.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map((entry) => {
                const installable = isInstallableEntry(entry);
                const pkg = entry.packageName || entry.installSpec || entry.id;
                const already = here.has(pkg) || (entry.installSpec ? here.has(entry.installSpec) : false);
                return (
                  <li
                    key={entry.id}
                    className="rounded-lg p-3"
                    style={{ border: "1px solid var(--border)", background: "var(--bg-input)" }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{entry.packageName || entry.repo}</p>
                        <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                          {blurb(entry, locale)}
                        </p>
                        <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
                          {t(tierKey(entry.tier))}
                          {entry.stars ? ` · ★ ${entry.stars}` : ""}
                          {entry.installSpec ? ` · ${entry.installSpec}` : ""}
                        </p>
                        {entry.runsBuildScript ? (
                          <p className="mt-1 text-xs" style={{ color: "var(--warn)" }}>
                            {t("plugins.buildScript")}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-col gap-1">
                        {already ? (
                          <span className="text-xs" style={{ color: "var(--text-faint)" }}>
                            {t("plugins.alreadyHere")}
                          </span>
                        ) : installable ? (
                          <button
                            type="button"
                            className="rounded px-2 py-1 text-xs text-white"
                            style={{ background: "var(--accent)" }}
                            disabled={Boolean(busy) || !space}
                            onClick={() =>
                              void run(t("busy.installPlugin"), () =>
                                window.dshSpaces.installPlugin({
                                  profiles: [space],
                                  catalogId: entry.id,
                                }),
                              )
                            }
                          >
                            {t("plugins.installable")}
                          </button>
                        ) : (
                          <span className="text-xs" style={{ color: "var(--text-faint)" }}>
                            {t("plugins.notInstallable")}
                          </span>
                        )}
                        <a
                          className="text-xs"
                          style={{ color: "var(--text-muted)" }}
                          href={entry.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          GitHub
                        </a>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div
        className="relative z-10 mt-3 shrink-0 pt-3"
        style={{ borderTop: "1px solid var(--border)", background: "var(--bg-main)" }}
      >
        <label className="text-xs" style={{ color: "var(--text-label)" }}>
          {t("plugins.catalogUrl")}
          <input
            className="field mt-1"
            value={catalogUrl}
            onChange={(event) => onCatalogUrl(event.target.value)}
            aria-label={t("plugins.catalogUrl")}
          />
        </label>
        <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
          {t("plugins.catalogUrlHint")}
        </p>
      </div>
      {restart.length > 0 ? (
        <div className="rounded-lg p-3" style={{ border: "1px solid var(--border)" }}>
          <p className="text-sm font-medium">{t("plugins.restartTitle")}</p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {t("plugins.restartHint", { names: restart.join(", ") })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {restart.map((name) => (
              <button
                key={name}
                type="button"
                className="rounded px-2 py-1 text-xs text-white"
                style={{ background: "var(--accent)" }}
                onClick={() => {
                  onRestart(name);
                  setRestart((current) => current.filter((item) => item !== name));
                }}
              >
                {t("plugins.restartOne", { name })}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="whitespace-pre-wrap text-sm" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      {busy ? (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>
          {busy}
        </p>
      ) : null}
    </div>
  );
}
