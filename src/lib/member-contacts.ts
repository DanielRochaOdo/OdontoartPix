export type ErpMobileContact = {
  phone: string;
  updatedAt: string | null;
  invoiceNumber: string;
};

function parseBrazilianDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
    ? `${year}-${month}-${day}` : null;
}

export function normalizeBrazilianMobile(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length === 13) digits = digits.slice(2);
  if (!/^[1-9][0-9]9[0-9]{8}$/.test(digits)) return null;
  return `55${digits}`;
}

export function extractErpMobileContacts(
  contacts: unknown,
  lastUpdates: unknown,
  invoiceNumber: string
): ErpMobileContact[] {
  if (typeof contacts !== "string") return [];
  const dates = lastUpdates && typeof lastUpdates === "object" && !Array.isArray(lastUpdates)
    ? lastUpdates as Record<string, unknown> : {};
  const found = new Map<string, ErpMobileContact>();
  for (const original of contacts.split(",")) {
    const raw = original.trim();
    const phone = normalizeBrazilianMobile(raw);
    if (!phone) continue;
    const updatedAt = parseBrazilianDate(dates[raw]);
    const existing = found.get(phone);
    if (!existing || (updatedAt ?? "") > (existing.updatedAt ?? "")) {
      found.set(phone, { phone, updatedAt, invoiceNumber });
    }
  }
  return [...found.values()];
}

export function topThreeMobileContacts<T extends { phone: string; updatedAt: string | null }>(
  contacts: T[]
): T[] {
  const unique = new Map<string, T>();
  for (const contact of contacts) {
    const previous = unique.get(contact.phone);
    if (!previous || (contact.updatedAt ?? "") > (previous.updatedAt ?? "")) {
      unique.set(contact.phone, contact);
    }
  }
  return [...unique.values()]
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
      a.phone.localeCompare(b.phone))
    .slice(0, 3);
}

export function displayContactDate(iso: string | null): string {
  return iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "";
}
