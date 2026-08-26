type InstallmentWithHistoryDate = {
  due_date_text: string | null;
  created_at?: string | null;
  id?: string | null;
};

function normalizeYear(value: number) {
  if (value >= 100) return value;
  return value >= 70 ? 1900 + value : 2000 + value;
}

function validUtcTimestamp(year: number, month: number, day: number) {
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return timestamp;
}

export function parseInstallmentDueDate(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\b|T)/.exec(text);
  if (iso) {
    return validUtcTimestamp(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = normalizeYear(Number(slash[3]));

    // O ERP atualmente devolve datas como M/D/YY (ex.: 8/15/26).
    // Se o primeiro campo for inequivocamente um dia (> 12), aceitamos
    // tambem D/M/YYYY para manter compatibilidade com dados antigos.
    const month = first > 12 && second <= 12 ? second : first;
    const day = first > 12 && second <= 12 ? first : second;
    const timestamp = validUtcTimestamp(year, month, day);
    if (timestamp !== null) return timestamp;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function fallbackTimestamp(value: string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function sortInstallmentsNewestFirst<T extends InstallmentWithHistoryDate>(
  installments: readonly T[]
) {
  return [...installments].sort((left, right) => {
    const leftDue = parseInstallmentDueDate(left.due_date_text) ?? Number.NEGATIVE_INFINITY;
    const rightDue = parseInstallmentDueDate(right.due_date_text) ?? Number.NEGATIVE_INFINITY;

    if (leftDue !== rightDue) return rightDue - leftDue;

    const leftCreated = fallbackTimestamp(left.created_at);
    const rightCreated = fallbackTimestamp(right.created_at);
    if (leftCreated !== rightCreated) return rightCreated - leftCreated;

    return String(right.id ?? "").localeCompare(String(left.id ?? ""));
  });
}
