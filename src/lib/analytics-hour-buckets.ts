/** Faixas fixas do relatorio de recebimentos (America/Fortaleza). */
export const ANALYTIC_HOURS = [
  "00-02", "02-04", "04-06", "06-08", "08-10", "10-12",
  "12-14", "14-16", "16-18", "18-20", "20-22", "22-00"
] as const;
export type AnalyticHour = typeof ANALYTIC_HOURS[number] | "between" | "unavailable";
