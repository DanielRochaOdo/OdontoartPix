"use client";

import Link from "next/link";
import { useState } from "react";
import type { PaymentFilters } from "@/lib/payment-punctuality";

type Option = { value: string; label: string };

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
}

// Mesmo padrão de interação de Associados: pesquisa, seleção múltipla,
// selecionar todos os resultados visíveis e limpar seleção.
function MultiSelectFilter({
  label, values, options, onChange
}: {
  label: string;
  values: string[];
  options: Option[];
  onChange: (values: string[]) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const searched = normalized(searchQuery);
  const visible = searched ? options.filter((option) => normalized(option.label).includes(searched)) : options;
  const visibleValues = visible.map((option) => option.value);
  const allVisibleSelected = visibleValues.length > 0 && visibleValues.every((value) => values.includes(value));
  const selectedLabels = options.filter((option) => values.includes(option.value)).map((option) => option.label);
  const summary = selectedLabels.length === 0
    ? `Todos: ${label}`
    : selectedLabels.length <= 2
      ? `${label}: ${selectedLabels.join(", ")}`
      : `${label}: ${selectedLabels.length} selecionados`;

  function toggleOne(value: string) {
    onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  }

  function toggleVisible() {
    const visibleSet = new Set(visibleValues);
    if (allVisibleSelected) onChange(values.filter((item) => !visibleSet.has(item)));
    else onChange([...new Set([...values, ...visibleValues])]);
  }

  return (
    <details className="group relative min-w-0" onToggle={(event) => { if (!event.currentTarget.open) setSearchQuery(""); }}>
      <summary className="flex min-h-[42px] cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary outline-none transition hover:bg-surface-hover focus:border-focus focus:ring-2 focus:ring-brand">
        <span className="truncate">{summary}</span>
        <span className="shrink-0 text-muted transition group-open:rotate-180">▾</span>
      </summary>
      <div className="absolute left-0 top-full z-50 mt-2 w-full min-w-[230px] rounded-xl border border-default bg-surface-elevated p-2 shadow-xl">
        <div className="mb-2 flex items-center gap-2">
          <input
            type="search" value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Pesquisar..." aria-label={`Pesquisar ${label}`}
            className="min-w-0 flex-1 rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm text-primary outline-none placeholder:text-muted focus:border-focus focus:ring-2 focus:ring-brand"
          />
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-default bg-surface-secondary px-2.5 py-2 text-xs font-medium text-secondary hover:bg-surface-hover">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible}
              disabled={visibleValues.length === 0}
              aria-label={searched ? `Selecionar todos os resultados de ${label}` : `Selecionar todos de ${label}`}
              className="h-4 w-4 rounded border-default" />
            Todos
          </label>
        </div>
        {values.length > 0 && (
          <button type="button" onClick={() => onChange([])}
            className="mb-1 w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-brand hover:bg-surface-hover">
            Limpar seleção
          </button>
        )}
        <div className="max-h-60 overflow-y-auto">
          {visible.length === 0
            ? <p className="px-3 py-2 text-xs text-muted">{options.length ? "Nenhuma opção encontrada." : "Nenhuma opção disponível."}</p>
            : visible.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-secondary hover:bg-surface-hover hover:text-primary">
                <input type="checkbox" checked={values.includes(option.value)}
                  onChange={() => toggleOne(option.value)} className="h-4 w-4 rounded border-default" />
                <span className="min-w-0 break-words">{option.label}</span>
              </label>
            ))}
        </div>
      </div>
    </details>
  );
}

function SingleSelect({
  name, label, selected, options, onChange
}: {
  name: string; label: string; selected: string; options: Option[];
  onChange?: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
      {label}
      <select name={name} defaultValue={selected} onChange={(event) => onChange?.(event.target.value)} className="odonto-control w-full px-3 py-2 text-[13px]">
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

const planOptions: Option[] = [
  { value: "clinico", label: "Clínico" }, { value: "orto", label: "Orto" },
  { value: "sem-classificacao", label: "Não classificado" }
];
const dueOptions: Option[] = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1), label: "Dia " + String(index + 1).padStart(2, "0")
}));
const scopeOptions: Option[] = [
  { value: "paid", label: "Pagas no prazo" },
  { value: "late", label: "Pagas com atraso" },
  { value: "open", label: "Em aberto e vencidas" }
];

export function PunctualityFilters({ filters, methods }: { filters: PaymentFilters; methods: string[] }) {
  const [plans, setPlans] = useState<string[]>(filters.plans);
  const [dues, setDues] = useState<string[]>(filters.dues.map(String));
  const [selectedMethods, setSelectedMethods] = useState<string[]>(filters.methods);
  const [scopes, setScopes] = useState<string[]>(filters.scopes);
  const [period, setPeriod] = useState(filters.period);
  const [customFrom, setCustomFrom] = useState(filters.period === "custom" ? filters.from : "");
  const [customTo, setCustomTo] = useState(filters.period === "custom" ? filters.to : "");

  return (
    <form action="/pontualidade" method="get" className="odonto-card mt-6 p-4 sm:p-5">
      <input type="hidden" name="tab" value={filters.tab} />
      {plans.map((value) => <input key={value} type="hidden" name="plan" value={value} />)}
      {dues.map((value) => <input key={value} type="hidden" name="due" value={value} />)}
      {selectedMethods.map((value) => <input key={value} type="hidden" name="method" value={value} />)}
      {scopes.map((value) => <input key={value} type="hidden" name="scopes" value={value} />)}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-primary">Filtros da análise</h2>
          <p className="mt-1 text-xs text-secondary">Selecione uma ou mais opções e pesquise dentro de cada lista. Os filtros permanecem ao trocar de aba.</p>
        </div>
        <Link href="/pontualidade" className="rounded-lg border border-default px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-hover">
          Limpar filtros
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <SingleSelect name="period" label="Período da análise" selected={filters.period} onChange={(value) => setPeriod(value as PaymentFilters["period"])} options={[
          { value: "all", label: "Todo o histórico" },
          { value: "30d", label: "Últimos 30 dias" },
          { value: "3m", label: "Últimos 3 meses" },
          { value: "6m", label: "Últimos 6 meses" },
          { value: "12m", label: "Últimos 12 meses" },
          { value: "custom", label: "Personalizado" }
        ]} />
        <SingleSelect name="dateBasis" label="Filtrar datas por" selected={filters.dateBasis} options={[
          { value: "payment", label: "Data de pagamento (como em Associados)" },
          { value: "due", label: "Data de vencimento" }
        ]} />
        <div className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
          Plano
          <MultiSelectFilter label="Planos" values={plans} onChange={setPlans} options={planOptions} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
          Dia do vencimento
          <MultiSelectFilter label="Vencimentos" values={dues} onChange={setDues} options={dueOptions} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
          Forma de pagamento
          <MultiSelectFilter label="Formas de pagamento" values={selectedMethods} onChange={setSelectedMethods}
            options={methods.map((item) => ({ value: item, label: item }))} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
          Situação das parcelas
          <MultiSelectFilter label="Situação" values={scopes} onChange={setScopes} options={scopeOptions} />
        </div>
        <SingleSelect name="metric" label="Ordenar por" selected={filters.metric} options={[
          { value: "avg", label: "Média de dias de atraso" },
          { value: "rate", label: "Percentual em atraso" },
          { value: "count", label: "Quantidade de parcelas" },
          { value: "amount", label: "Valor financeiro" }
        ]} />
        <SingleSelect name="order" label="Ordem" selected={filters.order} options={[
          { value: "desc", label: "Maior para menor" }, { value: "asc", label: "Menor para maior" }
        ]} />
        <div className="flex items-end">
          <button type="submit" disabled={!scopes.length}
            className="min-h-[42px] w-full rounded-lg bg-brand px-5 py-2 text-sm font-bold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
            Aplicar filtros
          </button>
        </div>
      </div>
      {!scopes.length && <p role="alert" className="mt-2 text-xs text-danger">Selecione ao menos uma situação de pagamento.</p>}
      {period === "custom" ? (
        <div className="mt-4 grid gap-3 border-t border-subtle pt-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-xs font-semibold text-secondary">
            Data inicial
            <input type="date" name="from" value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              max={customTo || undefined}
              className="odonto-control w-full px-3 py-2 text-[13px]" />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-semibold text-secondary">
            Data final
            <input type="date" name="to" value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              min={customFrom || undefined}
              className="odonto-control w-full px-3 py-2 text-[13px]" />
          </label>
        </div>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        O período usa a data de pagamento para parcelas quitadas, como em Associados, ou a data de vencimento, conforme a opção acima. Parcelas em aberto sempre usam o vencimento. Sem seleção de plano, dia ou forma de pagamento, todas as opções são consideradas.
      </p>
    </form>
  );
}
