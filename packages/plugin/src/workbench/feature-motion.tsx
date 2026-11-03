/**
 * Motion helpers for the workbench feature surfaces, built on the shared
 * primitives in `src/shared/ui/motion.tsx`.
 *
 * - `VisibleSlide` / `VisibleScale` move a panel while its opacity stays at 1,
 *   so an error or failure reason inside it is readable from the first frame
 *   (let it crash). They use the slightly snappier feature spring.
 * - `PressableButton` is the shared `PressButton` (disabled buttons never scale).
 * - `CollapseSection` expands and collapses a section with a height and an
 *   opacity transition. Only use it for sections that carry no failure content,
 *   because a collapsing section hides its content while it moves.
 *
 * Browser-only: imports React and `motion/react` and nothing else.
 */
import React from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import {
  PressButton,
  VisibleScale as SharedVisibleScale,
  VisibleSlide as SharedVisibleSlide,
  type MotionPrimitiveProps,
  type PressButtonProps,
  type VisibleMotionProps,
} from "../../../../src/shared/ui/motion";

/** Spring for panels that move into place inside the workbench. */
const featureSpring: Transition = { type: "spring", stiffness: 320, damping: 34, mass: 0.8 };

/** Slide a panel into place without ever hiding its content. */
export const VisibleSlide = React.forwardRef<HTMLElement, VisibleMotionProps>(function VisibleSlide(props, ref) {
  return <SharedVisibleSlide ref={ref} transition={featureSpring} {...props} />;
});

/** Scale a panel into place without ever hiding its content. */
export const VisibleScale = React.forwardRef<HTMLElement, VisibleMotionProps>(function VisibleScale(props, ref) {
  return <SharedVisibleScale ref={ref} transition={featureSpring} {...props} />;
});

/** Shared `PressButton`; the legacy `as="button"` prop is accepted and dropped. */
export const PressableButton = React.forwardRef<HTMLButtonElement, PressButtonProps & { as?: "button" }>(
  function PressableButton({ as: _as, ...props }, ref) {
    return <PressButton ref={ref} {...props} />;
  },
);

/** Props of `CollapseSection`. */
interface CollapseSectionProps extends MotionPrimitiveProps {
  /** Whether the section is expanded. */
  open: boolean;
  /** Height and opacity transition, in seconds. */
  duration?: number;
}

/**
 * Expand and collapse a section with a height and an opacity transition. The
 * `AnimatePresence` stays mounted, so the first render shows the expanded
 * state and every later change animates.
 */
export function CollapseSection({
  open,
  children,
  className,
  duration = 0.28,
  as: _as,
  ...rest
}: CollapseSectionProps): React.ReactElement {
  const Section = motion.div as unknown as React.ElementType;
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <Section
          key="collapse"
          className={className}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration, ease: [0.2, 0, 0, 1] }}
          style={{ overflow: "hidden" }}
          {...rest}
        >
          {children}
        </Section>
      ) : null}
    </AnimatePresence>
  );
}
