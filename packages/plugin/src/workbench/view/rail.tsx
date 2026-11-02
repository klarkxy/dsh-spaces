/**
 * The workbench rail.
 *
 * The rail keeps the Discord-style column of round space buttons. The
 * selection indicator is a shared-layout element that slides between the
 * slots, the buttons morph between a circle and a rounded square on hover and
 * selection, and the first load staggers the items in.
 */

import React, { type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { WorkbenchSpace } from "../../../../../src/shared/workbench";
import { LayoutIndicator } from "../../../../../src/shared/ui";
import { SpaceGlyph } from "../space-glyph";
import { t } from "../i18n";
import { statusKey, type WorkbenchViewProps } from "./shared";

/** Custom properties need a cast; React types only know the standard ones. */
type SlotStyle = CSSProperties & { "--dsh-wb-rail-delay"?: string };

export function Rail({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const spaces = controller.workspaceSpaces();
  const writable = controller.canMutate();
  return (
    <aside className="dsh-wb-rail" inert={ui.overlay?.type === "settings" || undefined} aria-label={t(locale, "app.title")}>
      <RailSlot active={ui.selected === "home"} delay="0ms">
        <RailButton
          label={t(locale, "app.home")}
          current={ui.selected === "home"}
          onClick={controller.selectHome}
          glyph="home"
        />
      </RailSlot>
      <div className="dsh-wb-rail-list" role="list">
        {spaces.map((space, index) => (
          <RailSlot key={space.id} active={ui.selected === space.id} delay={`${60 + index * 45}ms`}>
            <RailButton
              label={`${space.displayName} · ${t(locale, statusKey(space.status))}`}
              current={ui.selected === space.id}
              pending={ui.pendingId === space.id}
              status={space.status}
              icon={space.icon}
              spaceId={space.id}
              onClick={() => controller.selectSpace(space.id)}
              onMenu={(x, y) => controller.openMenu(space.id, x, y)}
              onMoveUp={writable ? () => controller.moveSpace(space.id, -1) : undefined}
              onMoveDown={writable ? () => controller.moveSpace(space.id, 1) : undefined}
              canMoveUp={index > 0}
              canMoveDown={index < spaces.length - 1}
            />
          </RailSlot>
        ))}
      </div>
      <RailSlot active={false} delay="120ms">
        <RailButton
          label={t(locale, "app.newSpace")}
          onClick={controller.openCreate}
          glyph="plus"
          disabled={!writable}
          tool
        />
      </RailSlot>
      <RailSlot active={false} delay="165ms">
        <RailButton label={t(locale, "app.settings")} onClick={controller.openSettings} glyph="gear" tool />
      </RailSlot>
    </aside>
  );
}

/**
 * One rail position.
 *
 * The slot owns the selection halo so that the shared layout animation is not
 * clipped by the button's own overflow lock.
 */
function RailSlot({ active, delay, children }: { active: boolean; delay: string; children: ReactNode }): ReactElement {
  return (
    <span className="dsh-wb-rail-slot" style={{ "--dsh-wb-rail-delay": delay } as SlotStyle}>
      {active ? <LayoutIndicator as="span" layoutId="dsh-wb-rail-selection" className="dsh-wb-rail-indicator" /> : null}
      {children}
    </span>
  );
}

function RailButton({
  label,
  current,
  pending,
  status,
  icon,
  spaceId,
  onClick,
  onMenu,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  glyph,
  disabled,
  tool,
}: {
  label: string;
  current?: boolean;
  pending?: boolean;
  status?: WorkbenchSpace["status"];
  icon?: string;
  spaceId?: string;
  onClick: () => void;
  onMenu?: (x: number, y: number) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  glyph?: "home" | "plus" | "gear";
  disabled?: boolean;
  tool?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={`dsh-wb-rail-btn${tool ? " tool" : ""}`}
      aria-label={label}
      title={label}
      aria-current={current ? "true" : undefined}
      aria-busy={pending || undefined}
      data-pending={pending ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
      onContextMenu={(event) => {
        if (!onMenu) return;
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu?.(rect.right, rect.top);
        }
        if (event.key === "ArrowUp" && event.altKey && canMoveUp) {
          event.preventDefault();
          onMoveUp?.();
        }
        if (event.key === "ArrowDown" && event.altKey && canMoveDown) {
          event.preventDefault();
          onMoveDown?.();
        }
      }}
    >
      {glyph === "home" ? <HomeGlyph /> : glyph === "plus" ? <PlusGlyph /> : glyph === "gear" ? <GearGlyph /> : <SpaceGlyph icon={icon} spaceId={spaceId} />}
      {status ? <span className="dsh-wb-status" data-status={status} aria-hidden="true" /> : null}
      <span className="dsh-wb-sr">{label}</span>
    </button>
  );
}

function HomeGlyph(): ReactElement {
  return <svg className="dsh-wb-glyph" viewBox="0 0 24 24" aria-hidden><path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z" /></svg>;
}

function PlusGlyph(): ReactElement {
  return (
    <svg className="dsh-wb-glyph" viewBox="0 0 24 24" aria-hidden>
      <path d="M11 5h2v14h-2zM5 11h14v2H5z" />
    </svg>
  );
}

function GearGlyph(): ReactElement {
  return (
    <svg className="dsh-wb-glyph" viewBox="0 0 24 24" aria-hidden>
      <path d="M10 3h4l.6 2.4 2.1.9 2.1-1.4 2.8 2.8-1.4 2.1.9 2.1L24 11v4l-2.4.6-.9 2.1 1.4 2.1-2.8 2.8-2.1-1.4-2.1.9L14 24h-4l-.6-2.4-2.1-.9-2.1 1.4L2.4 19.3l1.4-2.1-.9-2.1L0 14v-4l2.4-.6.9-2.1L1.9 5.2 4.7 2.4l2.1 1.4 2.1-.9zM12 9a3 3 0 1 0 .01 6.01A3 3 0 0 0 12 9z" />
    </svg>
  );
}
