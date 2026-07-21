export function toCents(value: unknown): { cents: number; warning?: string } {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { cents: Math.round(value * 100) };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return { cents: 0, warning: "Valor monetário vazio." };
    }

    const normalized = normalizeDecimalString(trimmed);
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return { cents: Math.round(parsed * 100) };
    }
  }

  return { cents: 0, warning: "Valor monetário inválido." };
}

function normalizeDecimalString(value: string) {
  const cleaned = value.replace(/\s/g, "").replace(/^R\$/i, "");
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      return cleaned.replace(/\./g, "").replace(",", ".");
    }
    return cleaned.replace(/,/g, "");
  }

  if (lastComma >= 0) {
    return cleaned.replace(/\./g, "").replace(",", ".");
  }

  return cleaned;
}

export function formatCurrencyBR(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(cents / 100);
}
