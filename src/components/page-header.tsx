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
    <header className="page-header flex flex-col gap-4 pb-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="page-header__identity flex min-w-0 items-start gap-3">
        <div className="min-w-0">
          {eyebrow ? <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-brand">{eyebrow}</p> : null}
          <h1 className="page-header__title odonto-page-title mt-1 text-primary">{title}</h1>
          {description ? <p className="page-header__description mt-2 max-w-3xl text-[13px] leading-relaxed text-secondary">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="page-header__actions flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
