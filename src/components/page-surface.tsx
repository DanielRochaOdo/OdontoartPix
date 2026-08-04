import type { ReactNode } from "react";

export function PageSurface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={`min-h-screen min-w-0 overflow-x-hidden bg-app p-4 text-primary lg:p-6 ${className}`}>{children}</main>;
}
