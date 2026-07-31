import { ProcessingSettingsForm } from "@/components/processing-settings-form";
import { getProcessingSettingsView } from "@/lib/processing-settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getProcessingSettingsView();

  return (
    <main className="p-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-emerald-700">
          Administracao
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Configuracoes</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Ajuste os perfis padrao do pipeline de processamento sem editar arquivos do ambiente.
        </p>
      </header>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Configuracao efetiva atual</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Preset atual</p>
            <p className="mt-1 text-xl font-semibold">
              {settings.selectedPresetKey ?? "Customizado"}
            </p>
          </article>
          <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Block size</p>
            <p className="mt-1 text-xl font-semibold">
              {settings.effectiveConfig.claimBatchSize}
            </p>
          </article>
          <article className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Concurrency</p>
            <p className="mt-1 text-xl font-semibold">
              {settings.effectiveConfig.perWorkerConcurrency}
            </p>
          </article>
        </div>
      </section>

      <ProcessingSettingsForm
        presets={settings.presets}
        selectedPresetKey={settings.selectedPresetKey}
      />
    </main>
  );
}
