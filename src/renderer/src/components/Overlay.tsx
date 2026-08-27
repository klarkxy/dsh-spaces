import type { ReactNode } from "react";

export function Overlay({
  children,
  onBackdrop,
}: {
  children: ReactNode;
  onBackdrop?: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default"
        onClick={onBackdrop}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`w-[420px] max-w-[calc(100vw-96px)] rounded-xl bg-[#2b2d31] p-5 shadow-xl ${className}`}>
      {children}
    </div>
  );
}
