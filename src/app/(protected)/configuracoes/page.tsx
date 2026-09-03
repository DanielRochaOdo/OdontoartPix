import { ProcessingSettingsForm } from "@/components/processing-settings-form";
import { SummaryAnalysisSettingsForm } from "@/components/summary-analysis-settings-form";
import { getProcessingSettingsView } from "@/lib/processing-settings";
import { getSummaryAnalysisSettings } from "@/lib/summary-analysis-settings";
import { formatCurrencyBR } from "@/lib/money";
import { PageSurface } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

const presetLabels = {
  conservador: "Conservador",
  mediano: "Mediano",
  agressivo: "Agressivo"
} as const;

function SettingsSummaryCard({
  eyebrow,
  title,
  description,
  value,
  valueLabel,
  href,
  active = false
}: {
  eyebrow: string;
  title: string;
  description: string;
  value: string;
  valueLabel: string;
  href: string;
  active?: boolean;
}) {
  return (
    <a
      href={href}
      className={`rounded-2xl border p-4 shadow-sm transition hover:bg-surface-hover ${
        active ? "border-brand bg-brand-soft" : "border-default bg-surface-primary"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{eyebrow}</p>
          <h2 className="mt-1 text-base font-semibold text-primary">{title}</h2>
        </div>
        <span className="text-muted">→</span>
      </div>
      <p className="mt-2 min-h-10 text-sm text-secondary">{description}</p>
      <div className="mt-4 border-t border-subtle pt-3">
        <p className="text-xs text-muted">{valueLabel}</p>
        <p className={`mt-1 text-sm font-semibold ${active ? "text-brand" : "text-primary"}`}>{value}</p>
      </div>
    </a>
  );
}

export default async function SettingsPage() {
  const [settings, analysisSettings] = await Promise.all([
    getProcessingSettingsView(),
    getSummaryAnalysisSettings()
  ]);
  const preset = settings.selectedPresetKey
    ? presetLabels[settings.selectedPresetKey]
    : "Customizado";

  return (
    <PageSurface>
      <PageHeader
        eyebrow="Administração"
        title="Configurações"
        description="Gerencie parâmetros de negócio, processamento e automação em áreas separadas e fáceis de localizar."
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SettingsSummaryCard
          eyebrow="Geral"
          title="Preferências gerais"
          description="Visão geral das definições administrativas e do ambiente operacional."
          value="Ambiente operacional"
          valueLabel="Contexto"
          href="#geral"
        />
        <SettingsSummaryCard
          eyebrow="Negócio"
          title="Resumo e Análise"
          description="Custos utilizados nos indicadores de retorno das ações de cobrança."
          value={formatCurrencyBR(analysisSettings.dispatchUnitCostCents)}
          valueLabel="Custo por disparo"
          href="#resumo-analise"
          active
        />
        <SettingsSummaryCard
          eyebrow="Operação"
          title="Processamento"
          description="Perfil de performance e parâmetros técnicos do pipeline."
          value={preset}
          valueLabel="Perfil atual"
          href="#processamento"
        />
        <SettingsSummaryCard
          eyebrow="Agenda"
          title="Automação"
          description="Ativação e frequência da sincronização automática do sistema."
          value={settings.automaticSyncEnabled ? `Ativada · ${settings.scheduledIntervalMinutes} min` : "Desativada"}
          valueLabel="Sincronização"
          href="#automacao"
        />
      </section>

      <div id="geral" className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)]">
        <SummaryAnalysisSettingsForm dispatchUnitCostCents={analysisSettings.dispatchUnitCostCents} />
        <aside className="space-y-4">
          <article className="rounded-2xl border border-default bg-surface-primary p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Processamento</p>
            <p className="mt-2 text-lg font-semibold text-primary">{preset}</p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-xs text-muted">Block size</p><p className="mt-1 font-semibold text-primary">{settings.effectiveConfig.claimBatchSize}</p></div>
              <div><p className="text-xs text-muted">Concorrência</p><p className="mt-1 font-semibold text-primary">{settings.effectiveConfig.perWorkerConcurrency}</p></div>
            </div>
            <a href="#processamento" className="mt-4 inline-flex text-sm font-semibold text-brand">Gerenciar processamento →</a>
          </article>

          <article className="rounded-2xl border border-default bg-surface-primary p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Automação</p>
            <p className={`mt-2 text-lg font-semibold ${settings.automaticSyncEnabled ? "text-success" : "text-primary"}`}>
              {settings.automaticSyncEnabled ? "Ativada" : "Desativada"}
            </p>
            <p className="mt-2 text-sm text-secondary">Frequência: {settings.scheduledIntervalMinutes} min</p>
            <a href="#automacao" className="mt-4 inline-flex text-sm font-semibold text-brand">Gerenciar automação →</a>
          </article>
        </aside>
      </div>

      <ProcessingSettingsForm
        presets={settings.presets}
        selectedPresetKey={settings.selectedPresetKey}
        scheduledIntervalMinutes={settings.scheduledIntervalMinutes}
        automaticSyncEnabled={settings.automaticSyncEnabled}
      />
    </PageSurface>
  );
}
