import type { ReactNode } from "react";

export function SurfaceCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-default bg-surface-primary text-primary shadow-sm ${className}`}>{children}</section>;
}
