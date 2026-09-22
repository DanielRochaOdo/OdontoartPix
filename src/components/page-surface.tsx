import type { ReactNode } from "react";

export function PageSurface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={`mx-auto min-h-[calc(100vh-73px)] w-full max-w-[1600px] min-w-0 overflow-x-hidden bg-app px-4 py-6 text-primary sm:px-6 lg:px-9 lg:py-7 ${className}`}>{children}</main>;
}
