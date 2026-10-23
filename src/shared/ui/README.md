# Shared UI foundation

Browser-only building blocks shared by the Workbench, the host Spaces panel,
the host Spaces panel and the Browser space client.

```ts
import { UI_TOKENS_CSS, MotionRoot, FadeIn, spring } from "../../shared/ui";
```

`src/shared/ui` is covered by `tsconfig.web.json` and `tsconfig.spaces.json`
(`src/shared/**/*`). It imports nothing from `src/adapters` and nothing from
Node, so it is safe to inline into a browser bundle.

## Tokens

`UI_TOKENS_CSS` is a CSS string. Inline it once per surface, before that
surface's own stylesheet:

```tsx
<style>{`${UI_TOKENS_CSS}${SURFACE_CSS}`}</style>
```

The token layer is scoped to `.dsh-ui`. Put `dsh-ui` on the surface root next
to the surface's own class so the custom properties resolve there and inherit
downwards:

```tsx
<div className="dsh-workbench dsh-ui" data-theme="dark">…</div>
```

It defines material colours, elevation (`--dsh-ui-shadow-sm|md|lg`, `--dsh-ui-glow`),
radii, a spacing scale, durations (`--dsh-ui-dur-fast|base|slow`), easing
curves (`--dsh-ui-ease-standard|emphasized|spring`), the glass surface
(`--dsh-ui-glass-bg`, `--dsh-ui-glass-blur`), the accent gradient and the focus
ring. Dark is the default; light follows the conventions the workbench already
uses (`data-theme="light"`, or `data-theme="system"` with
`prefers-color-scheme: light`).

Shared keyframes are prefixed `dsh-ui-`: `dsh-ui-fade-in`, `dsh-ui-scale-in`,
`dsh-ui-slide-up`, `dsh-ui-shimmer`, `dsh-ui-pulse`, `dsh-ui-spin`,
`dsh-ui-glow-breathe`.

### Mapping a surface onto the tokens

Surfaces keep their own variable names. `uiTokenMixin` writes the mapping:

```ts
import { uiTokenMixin } from "../../shared/ui";

const MAPPING = uiTokenMixin(".dsh-workbench", {
  "--wb-elev-md": "var(--dsh-ui-shadow-md)",
  "--wb-glass-bg": "var(--dsh-ui-glass-bg)",
});
```

The mapping only adds new properties, so no existing rule has to be rewritten.

## Motion primitives

Import path: `motion/react` (motion 14.4.0, the full React entry). The probe in
`.sandbox/motion-probe/` proved this entry pulls no `react-dom` and no second
React runtime into a client bundle, so the guard in `scripts/build-spaces.mjs`
keeps passing unchanged.

| Export | Signature |
| --- | --- |
| `MotionRoot` | `(props: MotionRootProps) => ReactElement` — provider only, renders no DOM node unless `as` is given; sets `reducedMotion="user"` |
| `spring` | `Transition` — stiff, immediate spring |
| `springSoft` | `Transition` — softer spring for larger surfaces |
| `fade` | `Transition` — 200 ms cross-fade |
| `stagger` | `(step?: number, delayChildren?: number) => Transition` — list stagger |
| `FadeIn` | `(props: EntranceProps) => ReactElement` — opacity entrance |
| `StaggerList` | `(props: StaggerListProps) => ReactElement` — staggered container |
| `StaggerItem` | `(props: StaggerItemProps) => ReactElement` — one child of a `StaggerList` |
| `Presence` | `AnimatePresence` — enter/exit presence |
| `PressButton` | `(props: PressButtonProps) => ReactElement` — `<button>` with the press micro-interaction; keeps `type`/`disabled`; disabled never scales |
| `VisibleSlide` | `(props: VisibleMotionProps) => ReactElement` — slides a panel in with opacity pinned at 1 (safe for failure content) |
| `VisibleScale` | `(props: VisibleMotionProps) => ReactElement` — scales a panel/dialog in with opacity pinned at 1 (safe for failure content) |
| `LayoutIndicator` | `(props: LayoutIndicatorProps) => ReactElement` — `layoutId` sliding indicator |

Every primitive forwards `className`, `style`, `id`, `role`, `aria-*`,
`data-*`, the standard DOM handlers and the ref. `as` picks the element and
defaults to `div`.

`MotionRoot` is exported only. Surfaces wrap their own root with it.

## Server rendering

The test suite renders with `renderToStaticMarkup`. `motion/react` writes the
entrance state into the server markup:

- `initial={{ opacity: 0 }}` renders `<div style="opacity:0">…</div>` — the text
  is in the markup, the element is hidden.
- `initial={false}` renders `<div style="opacity:1">…</div>` — visible.
- Without `initial`, no inline style is emitted — visible.

Content must always be present in server markup. It is: the primitives always
render their children.

## Error visibility

An animation must never hide, delay or soften a failure.

**Never wrap error, alert, failure-reason or notice content in an entrance
primitive without `appear={false}`.** With `appear={false}` the primitive uses
`initial={false}`, the server markup carries the visible end state and the real
failure appears immediately.

```tsx
<FadeIn appear={false} className="dsh-wb-alert" role="alert">{reason}</FadeIn>
```

Decorative entrances (cards, banners, list rows, dialogs) keep the default
`appear={true}`.

## Reduced motion

`MotionRoot` sets `reducedMotion="user"`, so the operating system's reduced
motion preference turns movement into opacity-only transitions. The token layer
disables CSS animations and transitions inside `.dsh-ui` under
`prefers-reduced-motion: reduce`.

## Surface rules

Each surface keeps its existing class names and aria attributes. The tests
depend on `dsh-wb-*` and `dsh-spaces-*` classes, on `data-*` attributes and on
the aria roles and states already in use. Restyling may add classes, but it
must not rename or remove an existing one.
