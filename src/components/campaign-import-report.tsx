"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "campaign-import-report";

type ImportIssue = {
  line?: number;
  associatedCode?: string;
  reason?: string;
};

type ImportReport = {
  campaignId?: string;
  message?: string;
  summary?: {
    imported_records?: number;
    skipped_duplicate_records?: number;
    invalid_records?: number;
    issues?: ImportIssue[];
  };
};

export function CampaignImportReport({ campaignId }: { campaignId: string }) {
  const [report, setReport] = useState<ImportReport | null>(null);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as ImportReport;
      if (parsed.campaignId !== campaignId) return;

      setReport(parsed);
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  }, [campaignId]);

  if (!report) return null;

  const issues = report.summary?.issues ?? [];

  return (
    <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-950 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Resumo da importação</h2>
          <p className="mt-1 text-sm">
            {report.message ?? "A importação foi concluída com observações."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReport(null)}
          className="rounded-lg border border-amber-300 px-3 py-1 text-sm transition hover:bg-amber-100"
        >
          Fechar
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <article className="rounded-xl border border-amber-200 bg-white/70 p-3">
          <p className="text-xs uppercase tracking-wide text-amber-700">Importados</p>
          <p className="mt-1 text-2xl font-semibold">
            {report.summary?.imported_records ?? 0}
          </p>
        </article>
        <article className="rounded-xl border border-amber-200 bg-white/70 p-3">
          <p className="text-xs uppercase tracking-wide text-amber-700">Ignorados</p>
          <p className="mt-1 text-2xl font-semibold">
            {report.summary?.invalid_records ?? 0}
          </p>
        </article>
        <article className="rounded-xl border border-amber-200 bg-white/70 p-3">
          <p className="text-xs uppercase tracking-wide text-amber-700">Duplicados</p>
          <p className="mt-1 text-2xl font-semibold">
            {report.summary?.skipped_duplicate_records ?? 0}
          </p>
        </article>
      </div>

      {issues.length > 0 ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-white/70 p-4">
          <p className="text-sm font-medium">Motivos dos registros não cadastrados</p>
          <div className="mt-3 max-h-72 overflow-y-auto pr-1">
            <table className="min-w-full text-sm">
              <thead className="text-left text-amber-800">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Linha</th>
                  <th className="pb-2 pr-4 font-medium">Código</th>
                  <th className="pb-2 font-medium">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue, index) => (
                  <tr
                    key={`${issue.line ?? "sem-linha"}-${index}`}
                    className="border-t border-amber-100"
                  >
                    <td className="py-2 pr-4 align-top">{issue.line ?? "-"}</td>
                    <td className="py-2 pr-4 align-top">{issue.associatedCode ?? "-"}</td>
                    <td className="py-2 align-top">{issue.reason ?? "Motivo não informado."}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
