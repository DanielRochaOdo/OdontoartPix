import type { ReactNode } from "react";

export function SemanticAlert({ kind = "danger", children }: { kind?: "danger" | "warning" | "info" | "success"; children: ReactNode }) {
  const styles = {
    danger: "border-danger bg-danger-soft text-danger",
    warning: "border-warning bg-warning-soft text-warning",
    info: "border-info bg-info-soft text-info",
    success: "border-success bg-success-soft text-success"
  }[kind];
  return <div className={`rounded-xl border p-4 text-sm ${styles}`}>{children}</div>;
}
