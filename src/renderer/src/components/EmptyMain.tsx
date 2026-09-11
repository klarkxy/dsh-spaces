import { useI18n } from "../i18n";

export function IdleMain({
  name,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: {
  name: string;
  onOpen: () => void;
  onCreate: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="relative z-[1] flex h-full items-center justify-center p-8">
      <div className="ui-card w-[420px] max-w-full p-5">
        <p className="ui-kicker">{t("cli.brand")}</p>
        <h2 className="mt-2 text-lg font-semibold text-balance">{t("idle.title", { name })}</h2>
        <p className="mt-2 text-sm leading-6 text-pretty" style={{ color: "var(--text-muted)" }}>
          {t("idle.body")}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {onRename ? (
              <button type="button" className="btn-ghost rounded px-2 py-1.5 text-sm" onClick={onRename}>
                {t("idle.rename")}
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                className="rounded px-2 py-1.5 text-sm"
                style={{ color: "var(--danger)" }}
                onClick={onDelete}
              >
                {t("idle.remove")}
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost rounded px-3 py-1.5 text-sm" onClick={onCreate}>
              {t("empty.create")}
            </button>
            <button type="button" className="btn-primary rounded px-3 py-1.5 text-sm" onClick={onOpen}>
              {t("idle.open", { name })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StartingMain({ name }: { name: string }) {
  const { t } = useI18n();
  return (
    <div className="relative z-[1] flex h-full items-center justify-center p-8">
      <div className="ui-card ui-card--live w-[420px] max-w-full p-5">
        <p className="ui-kicker">{t("cli.brand")}</p>
        <h2 className="mt-2 text-lg font-semibold text-balance">{t("starting.title", { name })}</h2>
        <p className="mt-2 text-sm leading-6 text-pretty" style={{ color: "var(--text-muted)" }}>
          {t("starting.body")}
        </p>
      </div>
    </div>
  );
}

export function EmptyMain({
  firstName,
  onOpen,
  onCreate,
}: {
  firstName?: string;
  onOpen?: () => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="relative z-[1] flex h-full items-center justify-center p-8">
      <div className="ui-card w-[420px] max-w-full p-5">
        <p className="ui-kicker">{t("cli.brand")}</p>
        <h2 className="mt-2 text-lg font-semibold text-balance">{t("empty.title")}</h2>
        <p className="mt-2 text-sm leading-6 text-pretty" style={{ color: "var(--text-muted)" }}>
          {t("empty.body")}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost rounded px-3 py-1.5 text-sm" onClick={onCreate}>
            {t("empty.create")}
          </button>
          {firstName && onOpen ? (
            <button
              type="button"
              className="btn-primary rounded px-3 py-1.5 text-sm"
              onClick={onOpen}
            >
              {t("empty.open", { name: firstName })}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
