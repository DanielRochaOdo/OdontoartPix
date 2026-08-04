import { ProcessingSettingsForm } from "@/components/processing-settings-form";
import { getProcessingSettingsView } from "@/lib/processing-settings";
import { PageSurface } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getProcessingSettingsView();

  return (
    <PageSurface>
      <PageHeader
        eyebrow="Administracao"
        title="Configuracoes"
        description="Ajuste os perfis padrao do pipeline de processamento sem editar arquivos do ambiente."
      />

      <section className="mt-6 rounded-2xl border border-default bg-surface-primary p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Configuracao efetiva atual</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <article className="rounded-xl border border-subtle bg-surface-secondary p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Preset atual</p>
            <p className="mt-1 text-xl font-semibold">
              {settings.selectedPresetKey ?? "Customizado"}
            </p>
          </article>
          <article className="rounded-xl border border-subtle bg-surface-secondary p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Block size</p>
            <p className="mt-1 text-xl font-semibold">
              {settings.effectiveConfig.claimBatchSize}
            </p>
          </article>
          <article className="rounded-xl border border-subtle bg-surface-secondary p-3">
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
    </PageSurface>
  );
}
