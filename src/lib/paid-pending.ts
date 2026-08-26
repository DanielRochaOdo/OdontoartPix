export type PaidPendingFilter = "all" | "yes" | "no";

export function normalizePaidPendingFilter(value: string | undefined): PaidPendingFilter {
  if (value === "yes" || value === "no") return value;
  return "all";
}

export function isPaidWithPending(paymentStatus: string, pendingAmountCents: number) {
  return paymentStatus === "paid" && Number(pendingAmountCents) > 0;
}

export function matchesPaidPendingFilter(
  paymentStatus: string,
  pendingAmountCents: number,
  filter: PaidPendingFilter
) {
  if (filter === "all") return true;
  if (filter === "yes") return isPaidWithPending(paymentStatus, pendingAmountCents);

  // A opcao "Nao" representa associados sem saldo pendente. Registros nao
  // pagos que ainda possuem valor em aberto nao entram nesse resultado.
  return Number(pendingAmountCents) <= 0;
}
