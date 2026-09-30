export type ReceiptPaymentSummaryName =
  | "ACORDADO"
  | "EXCLUIDA"
  | "BOLETO CLÍNICO"
  | "BOLETO ORTO"
  | "CARTÃO ORTO"
  | "CARTÃO CLÍNICO"
  | "DINHEIRO"
  | "ENEL"
  | "PIX CLÍNICO"
  | "PIX RECORRENTE"
  | "PIX ORTO";

export type ReceiptPaymentMapping = {
  description: string;
  systemLabel: string;
  summary: ReceiptPaymentSummaryName;
};

// Fonte funcional: tabela TIPO DE PAGAMENTO CADASTRADO EM SISTEMA ->
// TIPO DE PAGAMENTO RESUMIDO fornecida para o Dashboard.
// "0 - ABERTO" é deliberadamente excluído porque o Dashboard já possui card próprio.
export const RECEIPT_PAYMENT_MAPPING: readonly ReceiptPaymentMapping[] = [
  { description: "ACORDADO", systemLabel: "2 - ACORDADO", summary: "ACORDADO" },
  { description: "EXCLUIDA", systemLabel: "1 - EXCLUIDA", summary: "EXCLUIDA" },
  { description: "BANCO DO BRASIL CLINICO", systemLabel: "150 - BANCO DO BRASIL CLINICO", summary: "BOLETO CLÍNICO" },
  { description: "BANCO DO BRASIL ORTO", systemLabel: "161 - BANCO DO BRASIL ORTO", summary: "BOLETO ORTO" },
  { description: "CARTAO DE CREDITO - REDE - ORTO E PARTICULAR", systemLabel: "137 - CARTAO DE CREDITO - REDE - ORTO E PARTICULAR", summary: "CARTÃO ORTO" },
  { description: "CARTAO DE CREDITO - REDE - ORTO NEW ODONTOLOGIA", systemLabel: "162 - CARTAO DE CREDITO - REDE - ORTO NEW ODONTOLOGIA", summary: "CARTÃO ORTO" },
  { description: "CARTAO DE CRÉDITO NEW ODONTO - P4X", systemLabel: "159 - CARTAO DE CRÉDITO NEW ODONTO - P4X", summary: "CARTÃO ORTO" },
  { description: "CARTAO DE CRÉDITO NEW ODONTO - P4X EXTERNO", systemLabel: "169 - CARTAO DE CRÉDITO NEW ODONTO - P4X EXTERNO", summary: "CARTÃO ORTO" },
  { description: "CARTAO DE CRÉDITO NEW ODONTOLOGIA - P4X EXTERNO", systemLabel: "168 - CARTAO DE CRÉDITO NEW ODONTOLOGIA - P4X EXTERNO", summary: "CARTÃO ORTO" },
  { description: "CARTÃO DEBITO - ORTO E PARTICULAR", systemLabel: "140 - CARTÃO DEBITO - ORTO E PARTICULAR", summary: "CARTÃO ORTO" },
  { description: "CARTAO DE CRÉDITO ODONTOART - P4X", systemLabel: "157 - CARTAO DE CRÉDITO ODONTOART - P4X", summary: "CARTÃO CLÍNICO" },
  { description: "CARTAO DE CRÉDITO ODONTOART - P4X EXTERNO", systemLabel: "167 - CARTAO DE CRÉDITO ODONTOART - P4X EXTERNO", summary: "CARTÃO CLÍNICO" },
  { description: "DEBITO EM CONTA BB", systemLabel: "148 - DEBITO EM CONTA BB", summary: "CARTÃO CLÍNICO" },
  { description: "CARTAO DE CREDITO - REDE - PLANO", systemLabel: "129 - CARTAO DE CREDITO - REDE - PLANO", summary: "CARTÃO CLÍNICO" },
  { description: "DINHEIRO", systemLabel: "7 - DINHEIRO", summary: "DINHEIRO" },
  { description: "ENEL CE", systemLabel: "60 - ENEL CE", summary: "ENEL" },
  { description: "PIX - CLINICO", systemLabel: "11 - PIX - CLINICO", summary: "PIX CLÍNICO" },
  { description: "PIX ODONTOART - P4X", systemLabel: "170 - PIX ODONTOART - P4X", summary: "PIX CLÍNICO" },
  { description: "PIX RECORRENTE ODONTOART - P4X", systemLabel: "176 - PIX RECORRENTE ODONTOART - P4X", summary: "PIX RECORRENTE" },
  { description: "PIX - ORTODONTIA", systemLabel: "163 - PIX - ORTODONTIA", summary: "PIX ORTO" },
  { description: "PIX NEW ODONTO - P4X", systemLabel: "171 - PIX NEW ODONTO - P4X", summary: "PIX ORTO" },
  { description: "PIX NEW ODONTOLOGIA - P4X", systemLabel: "172 - PIX NEW ODONTOLOGIA - P4X", summary: "PIX ORTO" }
] as const;

export const RECEIPT_SUMMARY_ORDER: readonly ReceiptPaymentSummaryName[] = [
  "ACORDADO",
  "EXCLUIDA",
  "BOLETO CLÍNICO",
  "BOLETO ORTO",
  "CARTÃO ORTO",
  "CARTÃO CLÍNICO",
  "DINHEIRO",
  "ENEL",
  "PIX CLÍNICO",
  "PIX RECORRENTE",
  "PIX ORTO"
] as const;

export function normalizeReceiptPaymentDescription(value: string) {
  return value
    .replace(/^\s*\d+\s*-\s*/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleUpperCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

export function isOpenReceiptPayment(value: string) {
  return normalizeReceiptPaymentDescription(value) === "ABERTO";
}

export function findReceiptPaymentMapping(value: string) {
  const normalized = normalizeReceiptPaymentDescription(value);
  return RECEIPT_PAYMENT_MAPPING.find(
    (item) => normalizeReceiptPaymentDescription(item.description) === normalized
  ) ?? null;
}
