/**
 * Shared motion primitives.
 *
 * Browser-only: this module imports React and `motion/react` and nothing else.
 * It renders no DOM element on its own and never touches a Node adapter.
 *
 * Import path: `motion/react` (the full React entry of the `motion` package,
 * motion 14.4.0). The probe in `.sandbox/motion-probe/` proved that this entry
 * pulls no `react-dom` and no second React runtime into a client bundle, so
 * `scripts/build-spaces.mjs` keeps working unchanged.
 *
 * Two rules are part of the contract, not implementation details:
 *
 * 1. Server rendering keeps the content. `renderToStaticMarkup` emits the
 *    entrance state inline, so a decorative entrance renders `style="opacity:0"`
 *    on the server. The text is still in the markup, but the element is hidden.
 * 2. Error and alert content must never start hidden. Pass `appear={false}` on
 *    any entrance primitive that wraps an error, an alert, a failure reason or
 *    a notice. With `appear={false}` the primitive renders `initial={false}`,
 *    so the server markup carries the visible end state and the real failure
 *    shows up immediately.
 */
import React from "react";
import { AnimatePresence, MotionConfig, motion, stagger as motionStagger } from "motion/react";
import type { Target, Transition, Variants } from "motion/react";

/** Tags a surface may pick with the `as` prop. */
export type MotionTag = keyof HTMLElementTagNameMap;

const MOTION_TAGS = motion as unknown as Record<MotionTag, React.ElementType>;

function resolveMotionComponent(as: MotionTag | undefined): React.ElementType {
  return as ? MOTION_TAGS[as] : MOTION_TAGS.div;
}

/** Props shared by every primitive in this module. */
export interface MotionPrimitiveProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
  /** Element to render. Defaults to `div`. */
  as?: MotionTag;
  [key: `data-${string}`]: unknown;
}

/** Props of the entrance primitives. */
export interface EntranceProps extends MotionPrimitiveProps {
  /**
   * Run the entrance animation. Defaults to `true`.
   *
   * Pass `appear={false}` for error, alert, failure-reason and notice content:
   * the element then renders in its visible end state instead of fading in.
   */
  appear?: boolean;
  /** Extra delay in seconds, applied on top of the transition. */
  delay?: number;
  /** Transition used for the entrance. */
  transition?: Transition;
}

/** Spring for elements that should feel immediate but physical. */
export const spring: Transition = { type: "spring", stiffness: 420, damping: 32, mass: 0.9 };

/** Softer spring for larger surfaces such as dialogs and cards. */
export const springSoft: Transition = { type: "spring", stiffness: 220, damping: 26, mass: 1 };

/** Plain cross-fade that matches `--dsh-ui-ease-standard`. */
export const fade: Transition = { duration: 0.2, ease: [0.2, 0, 0, 1] };

/**
 * Stagger preset for lists: every child is delayed by `step` seconds after the
 * previous one.
 */
export function stagger(step = 0.05, delayChildren = 0): Transition {
  return { delayChildren: motionStagger(step, { startDelay: delayChildren }) };
}

/**
 * Root provider for a surface. It renders no DOM element unless `as` is given.
 *
 * It sets `reducedMotion="user"`, so a visitor who asked the operating system
 * for reduced motion gets opacity-only transitions instead of movement.
 */
export interface MotionRootProps {
  children?: React.ReactNode;
  /** Optional wrapper element. Without it, `MotionRoot` renders no DOM node. */
  as?: MotionTag;
  className?: string;
  style?: React.CSSProperties;
}

export const MotionRoot = React.forwardRef<HTMLElement, MotionRootProps>(function MotionRoot(props, ref) {
  const { children, as, className, style } = props;
  const content = as
    ? React.createElement(as, { className, style, ref } as React.HTMLAttributes<HTMLElement>, children)
    : children;
  return <MotionConfig reducedMotion="user">{content}</MotionConfig>;
});

/** Fade a surface in. Decorative by default; use `appear={false}` for errors. */
export const FadeIn = React.forwardRef<HTMLElement, EntranceProps>(function FadeIn(props, ref) {
  const { children, as, appear = true, delay = 0, transition = fade, ...rest } = props;
  const Component = resolveMotionComponent(as);
  return (
    <Component
      ref={ref}
      initial={appear ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={delay ? { ...transition, delay } : transition}
      {...rest}
    >
      {children}
    </Component>
  );
});

/** Props of `StaggerList`. */
export interface StaggerListProps extends MotionPrimitiveProps {
  /** Run the staggered entrance. Defaults to `true`. */
  appear?: boolean;
  /** Delay between two children, in seconds. */
  step?: number;
  /** Delay before the first child starts, in seconds. */
  delayChildren?: number;
}

/** Container that staggers its `StaggerItem` children. */
export const StaggerList = React.forwardRef<HTMLElement, StaggerListProps>(function StaggerList(props, ref) {
  const { children, as, appear = true, step = 0.05, delayChildren = 0, ...rest } = props;
  const Component = resolveMotionComponent(as);
  const variants: Variants = {
    hidden: {},
    show: { transition: { delayChildren: motionStagger(step, { startDelay: delayChildren }) } },
  };
  return (
    <Component
      ref={ref}
      variants={variants}
      initial={appear ? "hidden" : false}
      animate="show"
      {...rest}
    >
      {children}
    </Component>
  );
});

/** Props of `StaggerItem`. */
export interface StaggerItemProps extends Omit<MotionPrimitiveProps, "hidden"> {
  /** Run the staggered entrance. Defaults to `true`. */
  appear?: boolean;
  /** Hidden state of the item. */
  hidden?: Target;
  /** Visible state of the item. */
  show?: Target;
  /** Transition used for the item. */
  transition?: Transition;
}

/** One child of a `StaggerList`. */
export const StaggerItem = React.forwardRef<HTMLElement, StaggerItemProps>(function StaggerItem(props, ref) {
  const {
    children,
    as,
    appear = true,
    hidden = { opacity: 0, y: 6 },
    show = { opacity: 1, y: 0 },
    transition = springSoft,
    ...rest
  } = props;
  const Component = resolveMotionComponent(as);
  const variants: Variants = { hidden, show };
  return (
    <Component
      ref={ref}
      variants={variants}
      initial={appear ? "hidden" : false}
      animate="show"
      transition={transition}
      {...rest}
    >
      {children}
    </Component>
  );
});

/** Presence wrapper around `AnimatePresence`. */
export const Presence = AnimatePresence;

/** Props of `PressButton`. */
export type PressButtonProps = React.ComponentProps<typeof motion.button>;

/**
 * A `<button>` with the press micro-interaction. It keeps the button attributes (`type`, `disabled`, `form`), and a disabled
 * button never scales.
 */
export const PressButton = React.forwardRef<HTMLButtonElement, PressButtonProps>(function PressButton(props, ref) {
  const { whileHover, whileTap, transition = spring, disabled, ...rest } = props;
  return (
    <motion.button
      ref={ref}
      disabled={disabled}
      whileHover={disabled ? undefined : (whileHover ?? { scale: 1.04 })}
      whileTap={disabled ? undefined : (whileTap ?? { scale: 0.96 })}
      transition={transition}
      {...rest}
    />
  );
});

/** Props of the visible-motion primitives. */
export interface VisibleMotionProps extends MotionPrimitiveProps {
  /** Start offset: pixels for `VisibleSlide` (negative = from the left), scale for `VisibleScale`. */
  from?: number;
  /** Delay in seconds, applied on top of the transition. */
  delay?: number;
  /** Transition used for the movement. */
  transition?: Transition;
  /** Exit state, used when the panel sits inside a `Presence`. */
  exit?: Target;
}

/**
 * Move a panel into place while its opacity stays at 1 for the whole
 * animation. Safe for panels that can carry an error or a failure reason: the
 * real content is readable from the first frame (let it crash).
 */
export const VisibleSlide = React.forwardRef<HTMLElement, VisibleMotionProps>(function VisibleSlide(props, ref) {
  const { children, as, from = -14, delay = 0, transition = springSoft, exit, ...rest } = props;
  const Component = resolveMotionComponent(as);
  return (
    <Component
      ref={ref}
      initial={{ opacity: 1, x: from }}
      animate={{ opacity: 1, x: 0 }}
      exit={exit}
      transition={delay ? { ...transition, delay } : transition}
      {...rest}
    >
      {children}
    </Component>
  );
});

/** Scale a panel or dialog into place while its opacity stays at 1. See `VisibleSlide`. */
export const VisibleScale = React.forwardRef<HTMLElement, VisibleMotionProps>(function VisibleScale(props, ref) {
  const { children, as, from = 0.96, delay = 0, transition = springSoft, exit, ...rest } = props;
  const Component = resolveMotionComponent(as);
  return (
    <Component
      ref={ref}
      initial={{ opacity: 1, scale: from }}
      animate={{ opacity: 1, scale: 1 }}
      exit={exit}
      transition={delay ? { ...transition, delay } : transition}
      {...rest}
    >
      {children}
    </Component>
  );
});

/** Props of `LayoutIndicator`. */
export interface LayoutIndicatorProps extends MotionPrimitiveProps {
  /**
   * Shared layout id. Elements that share this id animate into each other's
   * place, which is how the rail selection pill and the tab underline slide.
   */
  layoutId: string;
  /** Whether the indicator is shown. Defaults to `true`. */
  active?: boolean;
}

/**
 * Sliding indicator driven by a shared layout id. Render one instance per
 * selectable item, always with the same `layoutId`; only the active one is
 * rendered inside the active item.
 */
export const LayoutIndicator = React.forwardRef<HTMLElement, LayoutIndicatorProps>(function LayoutIndicator(props, ref) {
  const { children, as, layoutId, active = true, style, ...rest } = props;
  const Component = resolveMotionComponent(as);
  return (
    <Component
      ref={ref}
      layoutId={layoutId}
      aria-hidden={active ? undefined : true}
      style={active ? style : { ...style, display: "none" }}
      transition={springSoft}
      {...rest}
    >
      {children}
    </Component>
  );
});
