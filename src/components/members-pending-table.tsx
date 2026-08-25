"use client";

import { useMemo, useState, type ComponentProps } from "react";
import { MembersTable } from "@/components/members-table";

 type MembersTableProps = ComponentProps<typeof MembersTable>;
type PendingFilter = "all" | "with" | "without";

function normalizePendingFilter(value: string | undefined): PendingFilter {
  if (value === "with" || value === "without") return value;
  return "all";
}

export function MembersPendingTable({
  members,
  initialFilters,
  canReprocessErrors,
  initialPendingFilter
}: MembersTableProps & { initialPendingFilter?: string }) {
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>(
    normalizePendingFilter(initialPendingFilter)
  );

  const filteredMembers = useMemo(() => {
    if (pendingFilter === "all") return members;
    if (pendingFilter === "with") {
      return members.filter((member) => Number(member.total_pending_amount_cents ?? 0) > 0);
    }
    return members.filter((member) => Number(member.total_pending_amount_cents ?? 0) <= 0);
  }, [members, pendingFilter]);

  const pendingCount = useMemo(
    () => members.filter((member) => Number(member.total_pending_amount_cents ?? 0) > 0).length,
    [members]
  );

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-amber-950">Pendências financeiras</p>
          <p className="mt-1 text-xs text-amber-800">
            {pendingCount} associado(s) possuem valor pendente. Ao filtrar, o XLSX exporta somente os registros exibidos.
          </p>
        </div>
        <label className="flex min-w-[220px] items-center gap-2 text-sm font-medium text-amber-950">
          <span>Visualizar</span>
          <select
            value={pendingFilter}
            onChange={(event) => setPendingFilter(normalizePendingFilter(event.target.value))}
            className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800"
            aria-label="Filtrar associados por pendência"
          >
            <option value="all">Todos</option>
            <option value="with">Somente com pendência</option>
            <option value="without">Somente sem pendência</option>
          </select>
        </label>
      </div>

      <MembersTable
        members={filteredMembers}
        initialFilters={initialFilters}
        canReprocessErrors={canReprocessErrors}
      />
    </>
  );
}
