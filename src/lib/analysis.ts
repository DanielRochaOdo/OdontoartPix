import { z } from "zod";
import { toCents } from "@/lib/money";

const StringOrNumberSchema = z.union([z.string(), z.number()]);
const NullableStringOrNumberSchema = StringOrNumberSchema.nullish();

const MonthlyParcelSchema = z
  .object({
    cod_usuario: NullableStringOrNumberSchema,
    cod_parcela: NullableStringOrNumberSchema,
    vencimento: z.string().nullish(),
    tipo_parcela: z.string().nullish(),
    cod_boleto: NullableStringOrNumberSchema,
    cod_pix: z.string().nullish(),
    link_cartão: z.string().nullish(),
    Situacao: z.string().nullish(),
    Valor: NullableStringOrNumberSchema,
    Multa: NullableStringOrNumberSchema,
    Juros: NullableStringOrNumberSchema,
    AcrescimoAvulso: NullableStringOrNumberSchema,
    DescontoAvulso: NullableStringOrNumberSchema,
    ValorFinal: NullableStringOrNumberSchema,
    Tipo_plano: z.string().nullish(),
    Observacao: z.string().nullish()
  })
  .passthrough();

const MonthlyLegacyResponseSchema = z
  .object({
    mensagem: z.string().nullish(),
    parcelas: z.array(MonthlyParcelSchema)
  })
  .passthrough();

const MonthlyApiDataItemSchema = z
  .object({
    Id: NullableStringOrNumberSchema,
    CodigoParcela: NullableStringOrNumberSchema,
    cod_parcela: NullableStringOrNumberSchema,
    cod_usuario: NullableStringOrNumberSchema,
    Valor: NullableStringOrNumberSchema,
    ValorFinal: NullableStringOrNumberSchema,
    ValorPago: NullableStringOrNumberSchema,
    ValorMultaJuros: NullableStringOrNumberSchema,
    ValorDescontoAvulso: NullableStringOrNumberSchema,
    DescricaoRecebimento: z.string().nullish(),
    DescricaoParcela: z.string().nullish(),
    DescricaoPagamento: z.string().nullish(),
    DataPagamento: z.string().nullish(),
    Situacao: z.string().nullish(),
    Tipo_plano: z.string().nullish(),
    tipo_parcela: z.string().nullish(),
    Multa: NullableStringOrNumberSchema,
    Juros: NullableStringOrNumberSchema,
    AcrescimoAvulso: NullableStringOrNumberSchema,
    DescontoAvulso: NullableStringOrNumberSchema,
    Observacao: z.string().nullish(),
    vencimento: z.string().nullish(),
    DataVencimento: z.string().nullish()
  })
  .passthrough();

const MonthlyPaginatedResponseSchema = z
  .object({
    codigo: z.number().nullish(),
    mensagem: z.string().nullish(),
    dados: z
      .object({
        RequestInfo: z.unknown().nullish(),
        CurrentPage: z.number().nullish(),
        TotalPages: z.number().nullish(),
        TotalCount: z.number().nullish(),
        PageSize: z.number().nullish(),
        Data: z.array(MonthlyApiDataItemSchema)
      })
      .passthrough(),
    erros: z.unknown().nullish()
  })
  .passthrough();

export class MonthlyResponseError extends Error {
  readonly code = "ERP_INVALID_RESPONSE";

  constructor(message: string) {
    super(message);
    this.name = "MonthlyResponseError";
  }
}

export type MonthlyInstallment = {
  userCode?: string;
  installmentCode: string;
  dueDate?: string;
  installmentType?: string;
  boletoCode?: string;
  pixCode?: string;
  cardPaymentLink?: string;
  situation?: string;
  paymentDescription?: string;
  paymentDate?: string;
  paidAmountCents: number | null;
  baseAmountCents: number;
  fineAmountCents: number;
  interestAmountCents: number;
  additionalAmountCents: number;
  discountAmountCents: number;
  finalAmountCents: number;
  planType: string;
  observation?: string;
};

export type MonthlyAnalysis = {
  paymentStatus: "paid" | "unpaid";
  paymentStatusSource: "erp_open_invoice" | "legacy_contract" | "erp_explicit";
  message: string;
  installmentsCount: number;
  totalPendingAmountCents: number;
  totalPaidAmountCents: number;
  totalsByPlan: Array<{
    planType: string;
    installmentsCount: number;
    totalAmountCents: number;
  }>;
  installments: MonthlyInstallment[];
  warnings: string[];
  paginationComplete: boolean;
  currentPage: number | null;
  totalPages: number | null;
  totalCount: number | null;
  pageSize: number | null;
};

export function analyzeTargetInstallment(input: {
  targetInstallmentId: string;
  invoices: Array<{ id: string | number | null | undefined; finalAmountCents: number }>;
  paginationComplete: boolean;
  message?: string;
}): MonthlyAnalysis {
  const targetId = String(input.targetInstallmentId).trim();
  const matched = input.invoices.find((invoice) => String(invoice.id ?? "").trim() === targetId);

  if (!matched && !input.paginationComplete) {
    throw new MonthlyResponseError(
      "A consulta paginada do ERP nao foi concluida; a fatura alvo nao pode ser classificada como paga."
    );
  }

  if (!matched) {
    return {
      paymentStatus: "unpaid",
      paymentStatusSource: "erp_open_invoice",
      message: input.message || "Parcela nao localizada para o associado informado.",
      installmentsCount: 0,
      totalPendingAmountCents: 0,
      totalPaidAmountCents: 0,
      totalsByPlan: [],
      installments: [],
      warnings: [],
      paginationComplete: true,
      currentPage: null,
      totalPages: null,
      totalCount: null,
      pageSize: null
    };
  }

  return {
    paymentStatus: "unpaid",
    paymentStatusSource: "erp_open_invoice",
    message: input.message || "Parcela localizada como pendente.",
    installmentsCount: 1,
    totalPendingAmountCents: matched.finalAmountCents,
    totalPaidAmountCents: 0,
    totalsByPlan: [{ planType: "Nao informado", installmentsCount: 1, totalAmountCents: matched.finalAmountCents }],
    installments: [{
      installmentCode: targetId,
      baseAmountCents: matched.finalAmountCents,
      fineAmountCents: 0,
      interestAmountCents: 0,
      additionalAmountCents: 0,
      discountAmountCents: 0,
      finalAmountCents: matched.finalAmountCents,
      planType: "Nao informado",
      paidAmountCents: null
    }],
    warnings: [],
    paginationComplete: input.paginationComplete,
    currentPage: null,
    totalPages: null,
    totalCount: null,
    pageSize: null
  };
}

type NormalizedLegacyPayload = {
  source: "legacy";
  message?: string;
  parcels: z.infer<typeof MonthlyParcelSchema>[];
};

type NormalizedPaginatedPayload = {
  source: "paginated";
  message?: string;
  items: z.infer<typeof MonthlyApiDataItemSchema>[];
  currentPage: number | null;
  totalPages: number | null;
  totalCount: number | null;
  pageSize: number | null;
};

function optionalText(value: unknown) {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function hasValue(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function isExplicitlyPaid(item: z.infer<typeof MonthlyApiDataItemSchema>) {
  const description = optionalText(item.DescricaoRecebimento);
  return Boolean(
    hasValue(item.ValorPago) &&
      description &&
      description.toLocaleUpperCase("pt-BR") !== "ABERTO"
  );
}

function installmentCodeFromApiItem(item: z.infer<typeof MonthlyApiDataItemSchema>) {
  return optionalText(item.Id) ?? optionalText(item.CodigoParcela) ?? optionalText(item.cod_parcela);
}

function isEmptyErros(value: unknown) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function validatePaginatedResponse(
  parsed: z.infer<typeof MonthlyPaginatedResponseSchema>
) {
  const data = parsed.dados;
  const currentPage = data.CurrentPage;
  const totalPages = data.TotalPages;
  const totalCount = data.TotalCount;
  const pageSize = data.PageSize;

  if (parsed.codigo !== 1 || !isEmptyErros(parsed.erros)) {
    throw new MonthlyResponseError("O ERP retornou erro funcional na consulta de mensalidades.");
  }

  if (
    currentPage == null ||
    totalPages == null ||
    totalCount == null ||
    pageSize == null ||
    currentPage < 1 ||
    totalPages < 0 ||
    totalCount < 0 ||
    pageSize < 0 ||
    (totalPages === 0 && data.Data.length !== 0) ||
    (totalPages > 0 && currentPage > totalPages) ||
    (pageSize > 0 && data.Data.length > pageSize)
  ) {
    throw new MonthlyResponseError("Os metadados de paginacao do ERP sao invalidos ou incompletos.");
  }
}

function monetaryValue(value: unknown, field: string, warnings: string[]) {
  const result = toCents(value);
  if (result.warning && value != null && String(value).trim() !== "") {
    warnings.push(`${field}: ${result.warning}`);
  }
  return result.cents;
}

function requiredApiValorCents(value: unknown, installmentCode: string) {
  if (!hasValue(value)) {
    throw new MonthlyResponseError(
      `A parcela ${installmentCode} não possui Valor informado pelo ERP.`
    );
  }

  const parsed = toCents(value);
  if (parsed.warning) {
    throw new MonthlyResponseError(
      `A parcela ${installmentCode} possui Valor inválido.`
    );
  }
  return parsed.cents;
}

function normalizeMonthlyPayload(input: unknown): NormalizedLegacyPayload | NormalizedPaginatedPayload {
  const legacy = MonthlyLegacyResponseSchema.safeParse(input);
  if (legacy.success) {
    return {
      source: "legacy",
      message: legacy.data.mensagem?.trim(),
      parcels: legacy.data.parcelas
    };
  }

  const paginated = MonthlyPaginatedResponseSchema.safeParse(input);
  if (paginated.success) {
    validatePaginatedResponse(paginated.data);
    return {
      source: "paginated",
      message: paginated.data.mensagem?.trim(),
      items: paginated.data.dados.Data,
      currentPage: paginated.data.dados.CurrentPage ?? null,
      totalPages: paginated.data.dados.TotalPages ?? null,
      totalCount: paginated.data.dados.TotalCount ?? null,
      pageSize: paginated.data.dados.PageSize ?? null
    };
  }

  throw new MonthlyResponseError(
    "A resposta do ERP não possui o contrato esperado."
  );
}

function analyzeLegacyPayload(payload: NormalizedLegacyPayload, targetInstallmentId?: string, fallbackDueDate?: string): MonthlyAnalysis {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const installments: MonthlyInstallment[] = [];

  for (const item of payload.parcels) {
    const installmentType = optionalText(item.tipo_parcela);
    if (installmentType?.toLocaleLowerCase("pt-BR") === "parcela virtual") {
      continue;
    }

    const installmentCode = optionalText(item.cod_parcela);
    if (!installmentCode) continue;

    const userCode = optionalText(item.cod_usuario);
    const dedupeKey = `${userCode ?? ""}:${installmentCode}`;
    if (seen.has(dedupeKey)) {
      warnings.push(`Parcela duplicada ignorada: ${installmentCode}.`);
      continue;
    }
    seen.add(dedupeKey);

    const finalAmount = toCents(item.ValorFinal);
    if (finalAmount.warning) {
      throw new MonthlyResponseError(
        `A parcela ${installmentCode} possui ValorFinal inválido.`
      );
    }

    installments.push({
      userCode,
      installmentCode,
      dueDate: optionalText(item.vencimento) ?? (installmentCode === targetInstallmentId ? optionalText(fallbackDueDate) : undefined),
      installmentType,
      boletoCode: optionalText(item.cod_boleto),
      pixCode: optionalText(item.cod_pix),
      cardPaymentLink: optionalText(item.link_cartão),
      situation: optionalText(item.Situacao),
      baseAmountCents: monetaryValue(item.Valor, "Valor", warnings),
      fineAmountCents: monetaryValue(item.Multa, "Multa", warnings),
      interestAmountCents: monetaryValue(item.Juros, "Juros", warnings),
      additionalAmountCents: monetaryValue(item.AcrescimoAvulso, "AcrescimoAvulso", warnings),
      discountAmountCents: monetaryValue(item.DescontoAvulso, "DescontoAvulso", warnings),
      finalAmountCents: finalAmount.cents,
      planType: optionalText(item.Tipo_plano) ?? "Não informado",
      observation: optionalText(item.Observacao),
      paidAmountCents: null
    });
  }

  if (installments.length === 0) {
    return {
      paymentStatus: "unpaid",
      paymentStatusSource: "legacy_contract",
      message: payload.message || "Associado sem mensalidades em aberto.",
      installmentsCount: 0,
      totalPendingAmountCents: 0,
      totalPaidAmountCents: 0,
      totalsByPlan: [],
      installments: [],
      warnings,
      paginationComplete: true,
      currentPage: null,
      totalPages: null,
      totalCount: null,
      pageSize: null
    };
  }

  const grouped = new Map<string, { installmentsCount: number; totalAmountCents: number }>();
  for (const installment of installments) {
    const current = grouped.get(installment.planType) ?? {
      installmentsCount: 0,
      totalAmountCents: 0
    };
    current.installmentsCount += 1;
    current.totalAmountCents += installment.finalAmountCents;
    grouped.set(installment.planType, current);
  }

  return {
    paymentStatus: "unpaid",
    paymentStatusSource: "legacy_contract",
    message: payload.message || "Associado possui mensalidades em aberto.",
    installmentsCount: installments.length,
    totalPendingAmountCents: installments.reduce((sum, installment) => sum + installment.finalAmountCents, 0),
    totalPaidAmountCents: 0,
    totalsByPlan: [...grouped.entries()].map(([planType, total]) => ({ planType, ...total })),
    installments,
    warnings,
    paginationComplete: true,
    currentPage: null,
    totalPages: null,
    totalCount: null,
    pageSize: null
  };
}

function analyzePaginatedPayload(
  payload: NormalizedPaginatedPayload,
  targetInstallmentId?: string,
  fallbackDueDate?: string,
  historyComplete = false
): MonthlyAnalysis {
  if (!targetInstallmentId) {
    throw new MonthlyResponseError(
      "A análise da API de mensalidades exige a parcela de destino."
    );
  }

  if (historyComplete) {
    return analyzeCompleteHistoryPayload(payload, targetInstallmentId, fallbackDueDate);
  }

  const matched = payload.items.find(
    (item) => installmentCodeFromApiItem(item) === String(targetInstallmentId).trim()
  );
  if (!matched) {
    const paginationComplete =
      payload.totalPages === 0 || payload.totalPages === 1;
    if (!paginationComplete) {
      throw new MonthlyResponseError(
        "A consulta paginada do ERP nao foi concluida; a fatura alvo nao pode ser classificada como paga."
      );
    }
    return {
      paymentStatus: "unpaid",
      paymentStatusSource: "erp_open_invoice",
      message: payload.message || "Parcela não localizada para o associado informado.",
      installmentsCount: 0,
      totalPendingAmountCents: 0,
      totalPaidAmountCents: 0,
      totalsByPlan: [],
      installments: [],
      warnings: [],
      paginationComplete: true,
      currentPage: payload.currentPage,
      totalPages: payload.totalPages,
      totalCount: payload.totalCount,
      pageSize: payload.pageSize
    };
  }

  const explicitlyPaid = isExplicitlyPaid(matched);
  const paidValue = toCents(matched.ValorPago);
  const baseAmountCents = requiredApiValorCents(matched.Valor, String(targetInstallmentId).trim());
  const finalAmount = toCents(matched.ValorFinal);
  if (explicitlyPaid && paidValue.warning) {
    throw new MonthlyResponseError(`A parcela ${targetInstallmentId} possui ValorPago inválido.`);
  }

  const description = optionalText(matched.DescricaoRecebimento);
  const installment: MonthlyInstallment = {
    userCode: optionalText(matched.cod_usuario),
    installmentCode: String(targetInstallmentId).trim(),
    dueDate: optionalText(matched.vencimento) ?? optionalText(matched.DataVencimento) ?? optionalText(fallbackDueDate),
    installmentType: optionalText(matched.tipo_parcela) ?? optionalText(matched.DescricaoParcela),
    situation: description,
    paymentDescription: description,
    paymentDate: optionalText(matched.DataPagamento),
    baseAmountCents,
    fineAmountCents: monetaryValue(matched.Multa ?? matched.ValorMultaJuros, "Multa", []),
    interestAmountCents: monetaryValue(matched.Juros, "Juros", []),
    additionalAmountCents: monetaryValue(matched.AcrescimoAvulso, "AcrescimoAvulso", []),
    discountAmountCents: monetaryValue(matched.DescontoAvulso ?? matched.ValorDescontoAvulso, "DescontoAvulso", []),
    paidAmountCents: explicitlyPaid ? paidValue.cents : null,
    finalAmountCents: finalAmount.warning ? baseAmountCents : finalAmount.cents,
    planType: optionalText(matched.Tipo_plano) ?? optionalText(matched.DescricaoParcela) ?? "Não informado",
    observation: optionalText(matched.Observacao) ?? optionalText(matched.DescricaoPagamento)
  };

  return {
    paymentStatus: explicitlyPaid ? "paid" : "unpaid",
    paymentStatusSource: explicitlyPaid ? "erp_explicit" : "erp_open_invoice",
    message: payload.message || (explicitlyPaid ? "Parcela paga conforme o ERP." : "Parcela localizada como pendente."),
    installmentsCount: 1,
    totalPendingAmountCents: explicitlyPaid ? 0 : installment.finalAmountCents,
    totalPaidAmountCents: explicitlyPaid ? paidValue.cents : 0,
    totalsByPlan: explicitlyPaid
      ? []
      : [{ planType: installment.planType, installmentsCount: 1, totalAmountCents: installment.finalAmountCents }],
    installments: [installment],
    warnings: finalAmount.warning && hasValue(matched.ValorFinal)
      ? [`ValorFinal da parcela ${targetInstallmentId}: ${finalAmount.warning}`]
      : [],
    paginationComplete: payload.totalPages === 0 || payload.totalPages === 1,
    currentPage: payload.currentPage,
    totalPages: payload.totalPages,
    totalCount: payload.totalCount,
    pageSize: payload.pageSize
  };
}

function analyzeCompleteHistoryPayload(
  payload: NormalizedPaginatedPayload,
  targetInstallmentId: string,
  fallbackDueDate?: string
): MonthlyAnalysis {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const installments: MonthlyInstallment[] = [];
  const normalizedTargetId = targetInstallmentId.trim();

  for (const item of payload.items) {
    const installmentCode = installmentCodeFromApiItem(item);
    if (!installmentCode) continue;
    if (seen.has(installmentCode)) {
      warnings.push(`Parcela duplicada ignorada: ${installmentCode}.`);
      continue;
    }
    seen.add(installmentCode);

    const explicitlyPaid = isExplicitlyPaid(item);
    const paidValue = toCents(item.ValorPago);
    if (explicitlyPaid && paidValue.warning) {
      throw new MonthlyResponseError(`A parcela ${installmentCode} possui ValorPago inválido.`);
    }

    const isTarget = installmentCode === normalizedTargetId;
    const baseValue = toCents(item.Valor);
    if (isTarget && (!hasValue(item.Valor) || baseValue.warning)) {
      throw new MonthlyResponseError(
        `A parcela ${installmentCode} ${!hasValue(item.Valor) ? "não possui Valor informado pelo ERP" : "possui Valor inválido"}.`
      );
    }
    if (!isTarget && baseValue.warning && hasValue(item.Valor)) {
      warnings.push(`Valor da parcela ${installmentCode}: ${baseValue.warning}`);
    }

    const finalValue = toCents(item.ValorFinal);
    if (finalValue.warning && hasValue(item.ValorFinal)) {
      warnings.push(`ValorFinal da parcela ${installmentCode}: ${finalValue.warning}`);
    }

    const baseAmountCents = baseValue.warning ? 0 : baseValue.cents;
    const description = optionalText(item.DescricaoRecebimento);
    installments.push({
      userCode: optionalText(item.cod_usuario),
      installmentCode,
      dueDate: optionalText(item.vencimento) ?? optionalText(item.DataVencimento) ?? (isTarget ? optionalText(fallbackDueDate) : undefined),
      installmentType: optionalText(item.tipo_parcela) ?? optionalText(item.DescricaoParcela),
      situation: description,
      paymentDescription: description,
      paymentDate: optionalText(item.DataPagamento),
      baseAmountCents,
      fineAmountCents: monetaryValue(item.Multa ?? item.ValorMultaJuros, "Multa", warnings),
      interestAmountCents: monetaryValue(item.Juros, "Juros", warnings),
      additionalAmountCents: monetaryValue(item.AcrescimoAvulso, "AcrescimoAvulso", warnings),
      discountAmountCents: monetaryValue(item.DescontoAvulso ?? item.ValorDescontoAvulso, "DescontoAvulso", warnings),
      finalAmountCents: finalValue.warning ? baseAmountCents : finalValue.cents,
      planType: optionalText(item.Tipo_plano) ?? optionalText(item.DescricaoParcela) ?? "Não informado",
      observation: optionalText(item.Observacao) ?? optionalText(item.DescricaoPagamento),
      paidAmountCents: explicitlyPaid ? paidValue.cents : null
    });
  }

  const target = installments.find((item) => item.installmentCode === normalizedTargetId);
  const pendingInstallments = installments.filter((item) => item.paidAmountCents === null);
  const grouped = new Map<string, { installmentsCount: number; totalAmountCents: number }>();
  for (const installment of pendingInstallments) {
    const current = grouped.get(installment.planType) ?? { installmentsCount: 0, totalAmountCents: 0 };
    current.installmentsCount += 1;
    current.totalAmountCents += installment.finalAmountCents;
    grouped.set(installment.planType, current);
  }

  const targetIsPaid = target?.paidAmountCents !== null && target?.paidAmountCents !== undefined;
  return {
    paymentStatus: targetIsPaid ? "paid" : "unpaid",
    paymentStatusSource: "erp_explicit",
    message: payload.message || (targetIsPaid ? "Parcela paga conforme o historico do ERP." : "Parcela em aberto conforme o historico do ERP."),
    installmentsCount: installments.length,
    totalPendingAmountCents: pendingInstallments.reduce((sum, installment) => sum + installment.finalAmountCents, 0),
    totalPaidAmountCents: installments.reduce((sum, installment) => sum + (installment.paidAmountCents ?? 0), 0),
    totalsByPlan: [...grouped.entries()].map(([planType, total]) => ({ planType, ...total })),
    installments,
    warnings,
    paginationComplete: payload.totalPages === 0 || payload.totalPages === 1,
    currentPage: payload.currentPage,
    totalPages: payload.totalPages,
    totalCount: payload.totalCount,
    pageSize: payload.pageSize
  };
}

export function analyzeMonthlyResponse(
  input: unknown,
  targetInstallmentId?: string,
  fallbackDueDate?: string,
  options?: { historyComplete?: boolean }
): MonthlyAnalysis {
  const normalized = normalizeMonthlyPayload(input);
  if (normalized.source === "paginated") {
    return analyzePaginatedPayload(normalized, targetInstallmentId, fallbackDueDate, options?.historyComplete === true);
  }
  return analyzeLegacyPayload(normalized, targetInstallmentId, fallbackDueDate);
}

export function analyzeMonthlyResponses(
  inputs: unknown[],
  targetInstallmentId?: string,
  fallbackDueDate?: string,
  options?: { historyComplete?: boolean }
): MonthlyAnalysis {
  if (inputs.length === 0) {
    throw new MonthlyResponseError("O ERP nao retornou nenhuma pagina de mensalidades.");
  }

  const normalized = inputs.map((input) => normalizeMonthlyPayload(input));
  if (normalized.length === 1 && normalized[0]?.source === "legacy") {
    return analyzeLegacyPayload(normalized[0], targetInstallmentId, fallbackDueDate);
  }

  if (normalized.some((payload) => payload.source !== "paginated")) {
    throw new MonthlyResponseError("O ERP retornou contratos diferentes entre as paginas de mensalidades.");
  }

  const pages = normalized as NormalizedPaginatedPayload[];
  const firstPage = pages[0];
  const totalPages = firstPage.totalPages ?? 0;
  const pagesComplete = totalPages === 0 || pages.length >= totalPages;

  if (pages.some((page) =>
    page.totalPages !== firstPage.totalPages ||
    page.totalCount !== firstPage.totalCount
  )) {
    throw new MonthlyResponseError("Os metadados de paginacao variaram entre as paginas do ERP.");
  }

  const mergedItems = pages.flatMap((page) => page.items);
  const targetId = String(targetInstallmentId ?? "").trim();
  const targetFound = Boolean(
    targetId && mergedItems.some((item) => installmentCodeFromApiItem(item) === targetId)
  );

  const analysis = analyzePaginatedPayload(
    {
      ...firstPage,
      items: mergedItems,
      currentPage: pages.at(-1)?.currentPage ?? firstPage.currentPage
    },
    targetInstallmentId,
    fallbackDueDate,
    options?.historyComplete === true && (pagesComplete || targetFound)
  );

  return {
    ...analysis,
    // false aqui significa apenas que nao percorremos o restante do historico.
    // A classificacao da parcela alvo continua conclusiva quando targetFound.
    paginationComplete: pagesComplete
  };
}
