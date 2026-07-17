import Link from "next/link";
import { CampaignImportForm } from "@/components/campaign-import-form";
import { getCampaigns } from "@/lib/data";
import { DataAccessError } from "@/lib/errors/data-access-error";

export default async function CampaignsPage() {
  let campaigns: Awaited<ReturnType<typeof getCampaigns>> = [];
  let errorMessage: string | null = null;

  try {
    campaigns = await getCampaigns();
  } catch (error) {
    errorMessage = error instanceof DataAccessError ? "Erro ao carregar campanhas." : "Erro inesperado.";
  }

  return (
    <main className="p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">Campanhas</p>
          <h1 className="mt-2 text-3xl font-semibold">Gestão de campanhas</h1>
        </div>
      </header>
      <section className="mt-6 grid gap-4 xl:grid-cols-3">
        <CampaignImportForm />
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
          {errorMessage ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{errorMessage}</div>
          ) : campaigns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
              Nenhuma campanha encontrada.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <tbody>
                  {campaigns.map((campaign) => (
                    <tr key={campaign.id} className="border-b">
                      <td className="px-4 py-3 font-medium">{campaign.name}</td>
                      <td className="px-4 py-3">{campaign.status}</td>
                      <td className="px-4 py-3">
                        <Link href={`/campanhas/${campaign.id}`} className="underline">
                          Abrir
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>
    </main>
  );
}
