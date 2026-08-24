import { z } from "zod";
import { toCents } from "@/lib/money";

const StringOrNumberSchema = z.union([z.string(), z.number()]);
const NullableStringOrNumberSchema = StringOrNumberSchema.nullish();
const OPEN_RECEIPT_DESCRIPTION = "ABERTO";

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
  paymentStatusSource: "erp_open_invoice" | "erp_explicit";
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

type NormalizedPaginatedPayload = {
  message?: string;
  items: z.infer<typeof MonthlyApiDataItemSchema>[];
  currentPage: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
};

type ItemFinancialState = {
  status: "paid" | "unpaid" | "invalid";
  baseAmountCents: number;
  paidAmountCents: number | null;
  description?: string;
  reason?: string;
};

function optionalText(value: unknown) {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function hasValue(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function normalizedReceiptDescription(value: unknown) {
  return optionalText(value)?.toLocaleUpperCase("pt-BR");
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

function validatePaginatedResponse(parsed: z.infer<typeof MonthlyPaginatedResponseSchema>) {
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

function normalizeMonthlyPayload(input: unknown): NormalizedPaginatedPayload {
  const parsed = MonthlyPaginatedResponseSchema.safeParse(input);
  if (!parsed.success) {
    throw new MonthlyResponseError(
      "A resposta do ERP nao possui o contrato paginado esperado."
    );
  }

  validatePaginatedResponse(parsed.data);
  return {
    message: parsed.data.mensagem?.trim(),
    items: parsed.data.dados.Data,
    currentPage: parsed.data.dados.CurrentPage!,
    totalPages: parsed.data.dados.TotalPages!,
    totalCount: parsed.data.dados.TotalCount!,
    pageSize: parsed.data.dados.PageSize!
  };
}

function monetaryValue(value: unknown, field: string, warnings: string[]) {
  const result = toCents(value);
  if (result.warning && hasValue(value)) {
    warnings.push(`${field}: ${result.warning}`);
  }
  return result.warning ? 0 : result.cents;
}

function requiredMoneyCents(value: unknown, field: string, installmentCode: string) {
  if (!hasValue(value)) {
    throw new MonthlyResponseError(
      `A parcela ${installmentCode} nao possui ${field} informado pelo ERP.`
    );
  }

  const parsed = toCents(value);
  if (parsed.warning) {
    throw new MonthlyResponseError(
      `A parcela ${installmentCode} possui ${field} invalido.`
    );
  }
  return parsed.cents;
}

function classifyFinancialState(
  item: z.infer<typeof MonthlyApiDataItemSchema>,
  installmentCode: string,
  strict: boolean
): ItemFinancialState {
  const description = normalizedReceiptDescription(item.DescricaoRecebimento);
  const baseValue = toCents(item.Valor);
  const baseAmountCents = baseValue.warning ? 0 : baseValue.cents;

  if (strict && (!hasValue(item.Valor) || baseValue.warning)) {
    return {
      status: "invalid",
      baseAmountCents,
      paidAmountCents: null,
      description,
      reason: !hasValue(item.Valor)
        ? `A parcela ${installmentCode} nao possui Valor informado pelo ERP.`
        : `A parcela ${installmentCode} possui Valor invalido.`
    };
  }

  if (description === OPEN_RECEIPT_DESCRIPTION) {
    return {
      status: "unpaid",
      baseAmountCents,
      paidAmountCents: null,
      description
    };
  }

  if (!description) {
    return {
      status: "invalid",
      baseAmountCents,
      paidAmountCents: null,
      reason: `A parcela ${installmentCode} nao possui DescricaoRecebimento informada pelo ERP.`
    };
  }

  if (!hasValue(item.ValorPago)) {
    return {
      status: "invalid",
      baseAmountCents,
      paidAmountCents: null,
      description,
      reason: `A parcela ${installmentCode} possui DescricaoRecebimento diferente de ABERTO sem ValorPago informado.`
    };
  }

  const paidValue = toCents(item.ValorPago);
  if (paidValue.warning) {
    return {
      status: "invalid",
      baseAmountCents,
      paidAmountCents: null,
      description,
      reason: `A parcela ${installmentCode} possui ValorPago invalido.`
    };
  }

  if (!baseValue.warning && paidValue.cents >= baseAmountCents) {
    return {
      status: "paid",
      baseAmountCents,
      paidAmountCents: paidValue.cents,
      description
    };
  }

  return {
    status: "invalid",
    baseAmountCents,
    paidAmountCents: paidValue.cents,
    description,
    reason: `A parcela ${installmentCode} possui DescricaoRecebimento diferente de ABERTO, mas ValorPago e menor que Valor.`
  };
}

function toInstallment(
  item: z.infer<typeof MonthlyApiDataItemSchema>,
  installmentCode: string,
  state: ItemFinancialState,
  warnings: string[],
  fallbackDueDate?: string,
  isTarget = false
): MonthlyInstallment {
  const finalValue = toCents(item.ValorFinal);
  if (finalValue.warning && hasValue(item.ValorFinal)) {
    warnings.push(`ValorFinal da parcela ${installmentCode}: ${finalValue.warning}`);
  }

  return {
    userCode: optionalText(item.cod_usuario),
    installmentCode,
    dueDate:
      optionalText(item.vencimento) ??
      optionalText(item.DataVencimento) ??
      (isTarget ? optionalText(fallbackDueDate) : undefined),
    installmentType: optionalText(item.tipo_parcela) ?? optionalText(item.DescricaoParcela),
    situation: optionalText(item.DescricaoRecebimento),
    paymentDescription: optionalText(item.DescricaoRecebimento),
    paymentDate: optionalText(item.DataPagamento),
    paidAmountCents: state.status === "paid" ? state.paidAmountCents : null,
    baseAmountCents: state.baseAmountCents,
    fineAmountCents: monetaryValue(item.Multa ?? item.ValorMultaJuros, "Multa", warnings),
    interestAmountCents: monetaryValue(item.Juros, "Juros", warnings),
    additionalAmountCents: monetaryValue(item.AcrescimoAvulso, "AcrescimoAvulso", warnings),
    discountAmountCents: monetaryValue(
      item.DescontoAvulso ?? item.ValorDescontoAvulso,
      "DescontoAvulso",
      warnings
    ),
    finalAmountCents: finalValue.warning ? state.baseAmountCents : finalValue.cents,
    planType: optionalText(item.Tipo_plano) ?? optionalText(item.DescricaoParcela) ?? "Nao informado",
    observation: optionalText(item.Observacao) ?? optionalText(item.DescricaoPagamento)
  };
}

function analyzeNormalizedPayload(
  payload: NormalizedPaginatedPayload,
  targetInstallmentId: string,
  fallbackDueDate: string | undefined,
  paginationComplete: boolean
): MonthlyAnalysis {
  const targetId = targetInstallmentId.trim();
  const targetItem = payload.items.find(
    (item) => installmentCodeFromApiItem(item) === targetId
  );

  if (!targetItem) {
    if (!paginationComplete) {
      throw new MonthlyResponseError(
        `A consulta paginada do ERP nao foi concluida e a parcela alvo ${targetId} ainda nao foi localizada.`
      );
    }
    throw new MonthlyResponseError(
      `A parcela alvo ${targetId} nao foi localizada apos a consulta das paginas informadas pelo ERP.`
    );
  }

  const targetState = classifyFinancialState(targetItem, targetId, true);
  if (targetState.status === "invalid") {
    throw new MonthlyResponseError(
      targetState.reason ?? `A parcela ${targetId} possui estado financeiro invalido.`
    );
  }

  const warnings: string[] = [];
  const seen = new Set<string>();
  const installments: MonthlyInstallment[] = [];

  for (const item of payload.items) {
    const installmentCode = installmentCodeFromApiItem(item);
    if (!installmentCode) continue;
    if (seen.has(installmentCode)) {
      warnings.push(`Parcela duplicada ignorada: ${installmentCode}.`);
      continue;
    }
    seen.add(installmentCode);

    const isTarget = installmentCode === targetId;
    const state = isTarget
      ? targetState
      : classifyFinancialState(item, installmentCode, false);

    if (!isTarget && state.status === "invalid") {
      warnings.push(
        state.reason ?? `A parcela ${installmentCode} possui estado financeiro invalido.`
      );
    }

    installments.push(
      toInstallment(
        item,
        installmentCode,
        state,
        warnings,
        fallbackDueDate,
        isTarget
      )
    );
  }

  const pendingInstallments = installments.filter(
    (installment) =>
      normalizedReceiptDescription(installment.paymentDescription) === OPEN_RECEIPT_DESCRIPTION
  );
  const grouped = new Map<string, { installmentsCount: number; totalAmountCents: number }>();
  for (const installment of pendingInstallments) {
    const current = grouped.get(installment.planType) ?? {
      installmentsCount: 0,
      totalAmountCents: 0
    };
    current.installmentsCount += 1;
    current.totalAmountCents += installment.baseAmountCents;
    grouped.set(installment.planType, current);
  }

  const targetPaid = targetState.status === "paid";
  return {
    paymentStatus: targetPaid ? "paid" : "unpaid",
    paymentStatusSource: targetPaid ? "erp_explicit" : "erp_open_invoice",
    message:
      payload.message ||
      (targetPaid
        ? "Parcela paga conforme DescricaoRecebimento e ValorPago do ERP."
        : "Parcela em aberto conforme DescricaoRecebimento do ERP."),
    installmentsCount: installments.length,
    totalPendingAmountCents: pendingInstallments.reduce(
      (sum, installment) => sum + installment.baseAmountCents,
      0
    ),
    totalPaidAmountCents: installments.reduce(
      (sum, installment) => sum + (installment.paidAmountCents ?? 0),
      0
    ),
    totalsByPlan: [...grouped.entries()].map(([planType, total]) => ({
      planType,
      ...total
    })),
    installments,
    warnings,
    paginationComplete,
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
  _options?: { historyComplete?: boolean }
): MonthlyAnalysis {
  const targetId = String(targetInstallmentId ?? "").trim();
  if (!targetId) {
    throw new MonthlyResponseError(
      "A analise da API de mensalidades exige a parcela alvo."
    );
  }

  const payload = normalizeMonthlyPayload(input);
  const paginationComplete = payload.totalPages === 0 || payload.totalPages === 1;
  return analyzeNormalizedPayload(
    payload,
    targetId,
    fallbackDueDate,
    paginationComplete
  );
}

export function analyzeMonthlyResponses(
  inputs: unknown[],
  targetInstallmentId: string,
  fallbackDueDate?: string,
  _options?: { historyComplete?: boolean }
): MonthlyAnalysis {
  if (inputs.length === 0) {
    throw new MonthlyResponseError("Nenhuma pagina do ERP foi informada para analise.");
  }

  const targetId = String(targetInstallmentId ?? "").trim();
  if (!targetId) {
    throw new MonthlyResponseError(
      "A analise da API de mensalidades exige a parcela alvo."
    );
  }

  const pages = inputs.map((input) => normalizeMonthlyPayload(input));
  const first = pages[0]!;
  const expectedTotalPages = first.totalPages;
  const expectedTotalCount = first.totalCount;
  const expectedPageSize = first.pageSize;
  const seenPages = new Set<number>();
  const mergedItems: z.infer<typeof MonthlyApiDataItemSchema>[] = [];

  for (const page of pages) {
    if (
      page.totalPages !== expectedTotalPages ||
      page.totalCount !== expectedTotalCount ||
      page.pageSize !== expectedPageSize
    ) {
      throw new MonthlyResponseError(
        "As paginas do ERP possuem metadados incompativeis entre si."
      );
    }
    if (seenPages.has(page.currentPage)) {
      throw new MonthlyResponseError(
        "As paginas do ERP estao duplicadas ou sem identificacao valida."
      );
    }
    seenPages.add(page.currentPage);
    mergedItems.push(...page.items);
  }

  const paginationComplete =
    expectedTotalPages === 0
      ? seenPages.size === 1 && seenPages.has(1)
      : seenPages.size === expectedTotalPages &&
        Array.from({ length: expectedTotalPages }, (_, index) => index + 1).every(
          (page) => seenPages.has(page)
        );

  const merged: NormalizedPaginatedPayload = {
    message: pages.find((page) => page.message)?.message,
    items: mergedItems,
    currentPage: Math.max(...seenPages),
    totalPages: expectedTotalPages,
    totalCount: expectedTotalCount,
    pageSize: expectedPageSize
  };

  return analyzeNormalizedPayload(
    merged,
    targetId,
    fallbackDueDate,
    paginationComplete
  );
}
