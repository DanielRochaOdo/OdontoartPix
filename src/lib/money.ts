export function toCents(value: unknown): { cents: number; warning?: string } {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { cents: Math.round(value * 100) };
  }

  if (typeof value === "string") {
    const normalized = value.replace(/\./g, "").replace(",", ".");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return { cents: Math.round(parsed * 100) };
  }

  return { cents: 0, warning: "Valor monetário inválido tratado como zero." };
}

export function formatCurrencyBR(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(cents / 100);
}
