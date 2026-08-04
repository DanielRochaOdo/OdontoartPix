import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  detail = false
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  detail?: boolean;
}) {
  return (
    <header className="page-header flex flex-col gap-4 border-b border-subtle pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="page-header__identity flex min-w-0 items-start gap-4">
        <span className="page-header__accent mt-1 h-10 w-1 shrink-0 rounded-full bg-brand" aria-hidden="true" />
        <div className="min-w-0">
          {eyebrow ? <p className={`text-sm font-medium uppercase tracking-[0.18em] ${detail ? "text-brand" : "text-brand"}`}>{eyebrow}</p> : null}
          <h1 className="page-header__title mt-1 text-3xl font-semibold tracking-tight text-primary lg:text-4xl">{title}</h1>
          {description ? <p className="page-header__description mt-2 max-w-3xl text-sm text-secondary">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="page-header__actions flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
