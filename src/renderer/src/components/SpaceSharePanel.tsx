import React from "react";

export interface SpaceShareChoice {
  id: string;
  name: string;
  displayName: string;
}

export function SpaceSharePanel({
  locale,
  templates,
  templateId,
  spaces,
  spaceId,
  includeConfig,
  notice,
  onTemplateId,
  onSpaceId,
  onIncludeConfig,
  onImport,
  onCreateFromTemplate,
  onExport,
}: {
  locale: "en" | "zh";
  templates: SpaceShareChoice[];
  templateId: string;
  spaces: SpaceShareChoice[];
  spaceId: string;
  includeConfig: boolean;
  notice: string;
  onTemplateId: (id: string) => void;
  onSpaceId: (id: string) => void;
  onIncludeConfig: (value: boolean) => void;
  onImport: () => void;
  onCreateFromTemplate: () => void;
  onExport: () => void;
}) {
  const zh = locale === "zh";
  return (
    <div>
      <button type="button" className="btn-ghost mt-4 rounded px-3 py-1.5 text-sm" onClick={onImport}>
        {zh ? "导入空间…" : "Import space…"}
      </button>
      <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
        {zh
          ? "从 .dshspace 分享包创建新空间。插件安装和启动是分开的结果。不会自动启动。"
          : "Creates a new space from a .dshspace share. Plugin install and start are separate results. The space is not started automatically."}
      </p>
      <label className="mt-3 block text-xs" style={{ color: "var(--text-label)" }}>
        {zh ? "模板" : "Template"}
        <select
          className="field mt-1"
          aria-label={zh ? "选择模板" : "Select template"}
          value={templateId}
          onChange={(event) => onTemplateId(event.target.value)}
          disabled={templates.length === 0}
        >
          {templates.length === 0 ? (
            <option value="">{zh ? "没有模板" : "No templates"}</option>
          ) : (
            templates.map((row) => (
              <option key={row.id} value={row.id}>
                {row.displayName || row.name}
              </option>
            ))
          )}
        </select>
      </label>
      <button
        type="button"
        className="btn-ghost mt-2 rounded px-3 py-1.5 text-sm"
        disabled={!templateId}
        onClick={onCreateFromTemplate}
      >
        {zh ? "从模板创建" : "Create from template"}
      </button>
      <label className="mt-3 block text-xs" style={{ color: "var(--text-label)" }}>
        {zh ? "导出空间" : "Export space"}
        <select
          className="field mt-1"
          aria-label={zh ? "选择要导出的空间" : "Select space to export"}
          value={spaceId}
          onChange={(event) => onSpaceId(event.target.value)}
          disabled={spaces.length === 0}
        >
          {spaces.length === 0 ? (
            <option value="">{zh ? "没有可导出的空间" : "No exportable spaces"}</option>
          ) : (
            spaces.map((row) => (
              <option key={row.id} value={row.id}>
                {row.displayName || row.name}
              </option>
            ))
          )}
        </select>
      </label>
      <label className="mt-2 flex items-center gap-2 text-xs" style={{ color: "var(--text-label)" }}>
        <input
          type="checkbox"
          checked={includeConfig}
          onChange={(event) => onIncludeConfig(event.target.checked)}
        />
        {zh ? "附带配置（保存前预览）" : "Include config (preview before save)"}
      </label>
      <button
        type="button"
        className="btn-ghost mt-2 rounded px-3 py-1.5 text-sm"
        disabled={!spaceId}
        onClick={onExport}
      >
        {zh ? "导出并预览…" : "Export and preview…"}
      </button>
      {notice ? (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs" role="status">
          {notice}
        </pre>
      ) : null}
    </div>
  );
}
