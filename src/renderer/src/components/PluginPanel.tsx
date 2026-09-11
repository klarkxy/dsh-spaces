import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import type {
  InstalledPlugin,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginLibraryEntry,
  ProfileRecord,
} from "@shared/types";
import {
  buildManageRows,
  formatCount,
  isInstallableEntry,
  matchesPluginQuery,
  pluginAliases,
  pluginDisplayName,
} from "@shared/plugin";
import type { MessageKey } from "@shared/i18n";
import { useI18n } from "../i18n";
import { Card, Overlay } from "./Overlay";

const PAGE_SIZE = 24;

type Tab = "manage" | "market";

const CATEGORY_KEYS: Record<string, MessageKey> = {
  "ui-experience": "plugins.catUi",
  ui: "plugins.catUi",
  "media-image": "plugins.catVision",
  media: "plugins.catVision",
  "agent-orchestration": "plugins.catAgent",
  agents: "plugins.catAgent",
  "plugin-manager": "plugins.catManager",
  other: "plugins.catOther",
  tools: "plugins.catTools",
  "developer-tools": "plugins.catTools",
  dev: "plugins.catTools",
};

function blurb(entry: PluginCatalogEntry, locale: string): string {
  if (locale === "zh") return entry.summary || entry.summaryEn || entry.description;
  return entry.summaryEn || entry.summary || entry.description;
}

function PluginAvatar({ owner }: { owner: string }) {
  const [failed, setFailed] = useState(false);
  const letter = (owner.trim()[0] || "?").toUpperCase();
  if (!failed && owner) {
    return (
      <img
        src={`https://github.com/${encodeURIComponent(owner)}.png?size=48`}
        alt=""
        className="size-5 rounded-full object-cover"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="flex size-5 items-center justify-center rounded-full text-[10px] font-medium"
      style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
    >
      {letter}
    </span>
  );
}

function othersWith(
  installed: Record<string, InstalledPlugin[]>,
  aliases: string[],
  current: string,
): string[] {
  const names = new Set(aliases);
  return Object.entries(installed)
    .filter(([name, list]) => name !== current && list.some((item) => names.has(item.name)))
    .map(([name]) => name);
}

function tabStyle(active: boolean) {
  return {
    color: active ? "var(--text)" : "var(--text-muted)",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
  };
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
  const [tab, setTab] = useState<Tab>("manage");
  const [space, setSpace] = useState(fallback);
  const [spec, setSpec] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [advanced, setAdvanced] = useState(false);
  const [remoteHits, setRemoteHits] = useState<PluginCatalogEntry[]>([]);
  const [catalog, setCatalog] = useState<PluginCatalogSnapshot | null>(null);
  const [library, setLibrary] = useState<PluginLibraryEntry[]>([]);
  const [installed, setInstalled] = useState<Record<string, InstalledPlugin[]>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [restart, setRestart] = useState<string[]>([]);

  useEffect(() => {
    if (selected && profiles.some((item) => item.name === selected)) {
      setSpace(selected);
    }
  }, [selected, profiles]);

  const refreshInstalled = async () => {
    setInstalled(await window.dshSpaces.listAllProfilePlugins());
    const listLibrary = window.dshSpaces.listPluginLibrary;
    if (typeof listLibrary === "function") {
      setLibrary(await listLibrary());
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
    void refreshInstalled().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    void loadCatalog(false);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setRemoteHits([]);
      return;
    }
    if (typeof window.dshSpaces.searchPluginCatalog !== "function") return;
    const timer = setTimeout(() => {
      void window.dshSpaces.searchPluginCatalog(q).then(setRemoteHits).catch(() => {
        setRemoteHits([]);
      });
    }, 280);
    return () => clearTimeout(timer);
  }, [query]);

  const run = async (label: string, action: () => Promise<{ running: string[] } | void>) => {
    setBusy(label);
    setError("");
    try {
      const result = await action();
      await refreshInstalled();
      if (result && result.running.length > 0) {
        setRestart((current) => [...new Set([...current, ...result.running])]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const currentList = installed[space] ?? [];
  const manageRows = useMemo(
    () => buildManageRows(library, currentList),
    [library, currentList],
  );
  const extraRows = manageRows.filter((row) => !row.protected);
  const downloadedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of library) {
      ids.add(entry.id);
      if (entry.catalogId) ids.add(entry.catalogId);
      for (const alias of pluginAliases(entry)) ids.add(alias);
    }
    return ids;
  }, [library]);

  const downloadable = useMemo(() => {
    const unique = new Map<string, PluginCatalogEntry>();
    for (const entry of catalog?.entries ?? []) unique.set(entry.id, entry);
    for (const entry of remoteHits) unique.set(entry.id, entry);
    return [...unique.values()].filter(isInstallableEntry);
  }, [catalog, remoteHits]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of downloadable) {
      if (!entry.category) continue;
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [downloadable]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = downloadable.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      return matchesPluginQuery(entry, q);
    });
    filtered.sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
    return filtered;
  }, [downloadable, query, category]);

  const shown = matches.slice(0, limit);
  const sourceLabel =
    catalog?.source === "remote"
      ? t("plugins.sourceRemote")
      : catalog?.source === "cache"
        ? t("plugins.sourceCache")
        : catalog
          ? t("plugins.sourceSeed")
          : "";

  const spaceLabel = (name: string) =>
    profiles.find((profile) => profile.name === name)?.meta.displayName || name;

  const categoryLabel = (slug: string) => {
    const key = CATEGORY_KEYS[slug];
    return key ? t(key) : slug.replace(/-/g, " ");
  };

  const alreadyDownloaded = (entry: PluginCatalogEntry) => {
    const pkg = entry.packageName || entry.installSpec || entry.id;
    return (
      downloadedIds.has(entry.id) ||
      downloadedIds.has(pkg) ||
      (entry.installSpec ? downloadedIds.has(entry.installSpec) : false)
    );
  };

  const libraryIdOf = (entry: PluginCatalogEntry) => {
    const pkg = entry.packageName || entry.installSpec || entry.id;
    return (
      library.find(
        (item) =>
          item.id === entry.id ||
          item.catalogId === entry.id ||
          pluginAliases(item).includes(pkg),
      )?.id ?? entry.id
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-4" role="tablist" aria-label={t("plugins.title")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "manage"}
          className="pb-1 text-sm"
          style={tabStyle(tab === "manage")}
          onClick={() => setTab("manage")}
        >
          {t("plugins.tabManage")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "market"}
          className="pb-1 text-sm"
          style={tabStyle(tab === "market")}
          onClick={() => setTab("market")}
        >
          {t("plugins.tabMarket")}
        </button>
      </div>

      {tab === "manage" ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
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
            {t("plugins.manageHint")}
          </p>
          {extraRows.length === 0 ? (
            <div className="rounded-lg p-3" style={{ border: "1px solid var(--border)" }}>
              <p className="text-sm" style={{ color: "var(--text-faint)" }}>
                {t("plugins.emptyLibrary")}
              </p>
              <button
                type="button"
                className="btn-primary mt-3 rounded px-3 py-1.5 text-sm"
                onClick={() => setTab("market")}
              >
                {t("plugins.openMarket")}
              </button>
            </div>
          ) : null}
          {manageRows.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {manageRows.map((row) => {
                const also = othersWith(installed, [row.packageName, row.id], space);
                const alsoLabels = also.map(spaceLabel);
                return (
                  <li
                    key={row.id}
                    className="flex items-start justify-between gap-3 rounded-lg px-3 py-2"
                    style={{ border: "1px solid var(--border)" }}
                  >
                    <label className="flex min-w-0 flex-1 items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={row.enabled}
                        disabled={row.protected || Boolean(busy) || !space}
                        onChange={() =>
                          void run(
                            row.enabled ? t("busy.removePlugin") : t("busy.installPlugin"),
                            () =>
                              window.dshSpaces.setSpacePlugin({
                                profile: space,
                                id: row.id,
                                enabled: !row.enabled,
                              }),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {row.title}
                          {row.version ? ` @ ${row.version}` : ""}
                        </span>
                        {also.length > 0 ? (
                          <span className="mt-0.5 block text-xs" style={{ color: "var(--text-faint)" }}>
                            {t("plugins.alsoOn", { names: alsoLabels.join(", ") })}
                          </span>
                        ) : null}
                      </span>
                    </label>
                    {row.protected ? (
                      <span className="shrink-0 text-xs" style={{ color: "var(--text-faint)" }}>
                        {t("plugins.locked")}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <div className="flex items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                style={{ color: "var(--text-faint)" }}
                aria-hidden
              />
              <input
                className="field pl-9"
                placeholder={t("plugins.searchHint")}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(PAGE_SIZE);
                }}
                aria-label={t("plugins.search")}
              />
            </label>
            <button
              type="button"
              className="btn-ghost flex shrink-0 items-center gap-1 rounded-full px-3 py-2 text-xs"
              disabled={Boolean(busy)}
              onClick={() => void loadCatalog(true)}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              {t("plugins.refresh")}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("plugins.category")}>
            <button
              type="button"
              className="rounded-full px-2.5 py-1 text-xs tabular-nums"
              style={{
                color: category === "all" ? "var(--accent-ink)" : "var(--text-muted)",
                background: category === "all" ? "var(--accent)" : "transparent",
                border: category === "all" ? "1px solid transparent" : "1px solid var(--border)",
              }}
              onClick={() => {
                setCategory("all");
                setLimit(PAGE_SIZE);
              }}
            >
              {t("plugins.categoryAll", { count: formatCount(downloadable.length) })}
            </button>
            {categoryCounts.map(([slug]) => {
              const active = category === slug;
              return (
                <button
                  key={slug}
                  type="button"
                  className="rounded-full px-2.5 py-1 text-xs tabular-nums"
                  style={{
                    color: active ? "var(--accent-ink)" : "var(--text-muted)",
                    background: active ? "var(--accent)" : "transparent",
                    border: active ? "1px solid transparent" : "1px solid var(--border)",
                  }}
                  onClick={() => {
                    setCategory(slug);
                    setLimit(PAGE_SIZE);
                  }}
                >
                  {categoryLabel(slug)}
                </button>
              );
            })}
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
              <ul className="grid grid-cols-2 gap-3">
                {shown.map((entry) => {
                  const already = alreadyDownloaded(entry);
                  const libraryId = libraryIdOf(entry);
                  return (
                    <li
                      key={entry.id}
                      className="flex flex-col rounded-xl p-3"
                      style={{ border: "1px solid var(--border)", background: "var(--bg-input)" }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <a
                          className="min-w-0 truncate text-sm font-medium"
                          href={entry.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {pluginDisplayName(entry)}
                        </a>
                        {already ? (
                          <button
                            type="button"
                            className="shrink-0 rounded-full px-3 py-1 text-xs"
                            style={{ color: "var(--danger)", border: "1px solid var(--border)" }}
                            disabled={Boolean(busy)}
                            onClick={() =>
                              void run(t("busy.removeDownload"), async () => {
                                if (typeof window.dshSpaces.removeLibraryPlugin === "function") {
                                  setLibrary(await window.dshSpaces.removeLibraryPlugin(libraryId));
                                }
                              })
                            }
                          >
                            {t("plugins.removeDownload")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-primary shrink-0 rounded-full px-3 py-1 text-xs"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              void run(t("busy.downloadPlugin"), async () => {
                                await window.dshSpaces.downloadPlugin({ catalogId: entry.id });
                              })
                            }
                          >
                            {t("plugins.download")}
                          </button>
                        )}
                      </div>
                      <p
                        className="mt-1 flex items-center gap-1.5 text-xs tabular-nums"
                        style={{ color: "var(--text-faint)" }}
                      >
                        <PluginAvatar owner={entry.owner} />
                        <span className="truncate">{entry.owner}</span>
                        {entry.stars ? <span>· ★ {formatCount(entry.stars)}</span> : null}
                      </p>
                      <p
                        className="mt-2 line-clamp-3 min-h-0 flex-1 text-xs text-pretty"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {blurb(entry, locale)}
                      </p>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        {entry.category ? (
                          <span
                            className="rounded-full px-2 py-0.5 text-[11px]"
                            style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}
                          >
                            {categoryLabel(entry.category)}
                          </span>
                        ) : (
                          <span />
                        )}
                        {already ? (
                          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                            {t("plugins.downloaded")}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {shown.length < matches.length ? (
              <button
                type="button"
                className="mt-4 w-full text-sm"
                style={{ color: "var(--text-muted)" }}
                onClick={() => setLimit((current) => current + PAGE_SIZE)}
              >
                {t("plugins.more")}
              </button>
            ) : null}
          </div>
          <div className="shrink-0">
            <button
              type="button"
              className="text-xs"
              style={{ color: "var(--text-faint)" }}
              onClick={() => setAdvanced((open) => !open)}
            >
              {t("plugins.advanced")}
            </button>
            {advanced ? (
              <div className="mt-2 flex flex-col gap-2">
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
                    className="btn-primary rounded-full px-3 py-1.5 text-xs"
                    disabled={Boolean(busy) || !spec.trim()}
                    onClick={() =>
                      void run(t("busy.downloadPlugin"), async () => {
                        await window.dshSpaces.downloadPlugin({ spec: spec.trim() });
                      })
                    }
                  >
                    {t("plugins.downloadSpec")}
                  </button>
                </div>
                <label className="text-xs" style={{ color: "var(--text-label)" }}>
                  {t("plugins.catalogUrl")}
                  <input
                    className="field mt-1"
                    value={catalogUrl}
                    onChange={(event) => onCatalogUrl(event.target.value)}
                    aria-label={t("plugins.catalogUrl")}
                  />
                </label>
                <p className="text-xs" style={{ color: "var(--text-faint)" }}>
                  {t("plugins.catalogUrlHint")}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {restart.length > 0 ? (
        <div className="mt-3 rounded-lg p-3" style={{ border: "1px solid var(--border)" }}>
          <p className="text-sm font-medium">{t("plugins.restartTitle")}</p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {t("plugins.restartHint", { names: restart.join(", ") })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {restart.map((name) => (
              <button
                key={name}
                type="button"
                className="btn-primary rounded px-2 py-1 text-xs"
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
        <p className="mt-2 whitespace-pre-wrap text-sm" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      {busy ? (
        <p className="mt-2 text-sm" style={{ color: "var(--text-faint)" }}>
          {busy}
        </p>
      ) : null}
    </div>
  );
}

export function PluginDialog({
  profiles,
  selected,
  initialCatalogUrl,
  pluginPending,
  pluginCurrent,
  onClose,
  onRestart,
  onSaveCatalogUrl,
}: {
  profiles: ProfileRecord[];
  selected: string | null;
  initialCatalogUrl: string;
  pluginPending: number;
  pluginCurrent?: string;
  onClose: () => void;
  onRestart: (name: string) => void;
  onSaveCatalogUrl: (url: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [catalogUrl, setCatalogUrl] = useState(initialCatalogUrl);
  const close = () => {
    const persist =
      catalogUrl === initialCatalogUrl ? Promise.resolve() : onSaveCatalogUrl(catalogUrl);
    void persist.finally(onClose);
  };
  return (
    <Overlay onBackdrop={close}>
      <Card wide>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">{t("plugins.title")}</h2>
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={close}
          >
            {t("common.close")}
          </button>
        </div>
        {pluginPending > 0 ? (
          <p className="mb-3 text-sm" style={{ color: "var(--warn)" }}>
            {pluginCurrent
              ? t("settings.pluginQueueBusyCurrent", { count: pluginPending, current: pluginCurrent })
              : t("settings.pluginQueueBusy", { count: pluginPending })}
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">
          <PluginPanel
            profiles={profiles}
            selected={selected}
            catalogUrl={catalogUrl}
            onCatalogUrl={setCatalogUrl}
            onRestart={onRestart}
          />
        </div>
      </Card>
    </Overlay>
  );
}
