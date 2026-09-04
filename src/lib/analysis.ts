import { z } from "zod";
import { toCents } from "@/lib/money";

const StringOrNumberSchema = z.union([z.string(), z.number()]);
const NullableStringOrNumberSchema = StringOrNumberSchema.nullish();
const OPEN_RECEIPT_DESCRIPTION = "ABERTO";
const AGREED_RECEIPT_DESCRIPTION = "ACORDADO";
const EXCLUDED_RECEIPT_DESCRIPTION = "EXCLUIDA";

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

export type MonthlyPaymentStatus = "paid" | "unpaid" | "agreed" | "excluded";
export type MonthlyPaymentStatusSource =
  | "erp_open_invoice"
  | "erp_explicit"
  | "erp_agreed"
  | "erp_excluded";

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

export type MonthlyTargetFinancialState = {
  installmentCode: string;
  paymentStatus: MonthlyPaymentStatus;
  paymentStatusSource: MonthlyPaymentStatusSource;
  installmentAmountCents: number;
  paymentAmountCents: number;
  pendingAmountCents: number;
};

export type MonthlyAnalysis = {
  paymentStatus: MonthlyPaymentStatus;
  paymentStatusSource: MonthlyPaymentStatusSource;
  targetFinancialState: MonthlyTargetFinancialState;
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
  status: MonthlyPaymentStatus | "invalid";
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

function moneyState(value: unknown) {
  if (!hasValue(value)) return { kind: "missing" as const, cents: 0 };
  const parsed = toCents(value);
  if (parsed.warning || !Number.isSafeInteger(parsed.cents)) {
    return { kind: "invalid" as const, cents: 0 };
  }
  if (parsed.cents < 0) return { kind: "negative" as const, cents: parsed.cents };
  return { kind: "valid" as const, cents: parsed.cents };
}

function moneyStateReason(
  state: ReturnType<typeof moneyState>,
  field: string,
  installmentCode: string
) {
  if (state.kind === "missing") {
    return `A parcela ${installmentCode} nao possui ${field} informado pelo ERP.`;
  }
  if (state.kind === "negative") {
    return `A parcela ${installmentCode} possui ${field} negativo, fora do contrato financeiro esperado.`;
  }
  return `A parcela ${installmentCode} possui ${field} invalido.`;
}

function classifyFinancialState(
  item: z.infer<typeof MonthlyApiDataItemSchema>,
  installmentCode: string,
  _strict: boolean
): ItemFinancialState {
  const description = normalizedReceiptDescription(item.DescricaoRecebimento);
  const base = moneyState(item.Valor);
  const baseAmountCents = base.kind === "valid" ? base.cents : 0;

  if (base.kind !== "valid") {
    return {
      status: "invalid",
      baseAmountCents,
      paidAmountCents: null,
      description,
      reason: moneyStateReason(base, "Valor", installmentCode)
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

  if (description === AGREED_RECEIPT_DESCRIPTION) {
    return {
      status: "agreed",
      baseAmountCents,
      paidAmountCents: null,
      description
    };
  }

  if (description === EXCLUDED_RECEIPT_DESCRIPTION) {
    return {
      status: "excluded",
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

  const paid = moneyState(item.ValorPago);
  if (paid.kind !== "valid") {
    return {
      status: "invalid",
      baseAmountCents,
      paidAmountCents: null,
      description,
      reason: moneyStateReason(paid, "ValorPago", installmentCode)
    };
  }

  if (paid.cents === 0) {
    return {
      status: "invalid",
      baseAmountCents,
      paidAmountCents: 0,
      description,
      reason: `A parcela ${installmentCode} informa recebimento ${description}, mas ValorPago e zero.`
    };
  }

  // DescricaoRecebimento diferente de ABERTO/ACORDADO/EXCLUIDA representa
  // recebimento confirmado pelo ERP. ValorPago inferior ao Valor e um pagamento
  // parcial, nao uma falha tecnica. O saldo residual e calculado separadamente.
  return {
    status: "paid",
    baseAmountCents,
    paidAmountCents: paid.cents,
    description
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

function pendingAmountForInstallment(installment: MonthlyInstallment) {
  if (normalizedReceiptDescription(installment.paymentDescription) === OPEN_RECEIPT_DESCRIPTION) {
    return installment.baseAmountCents;
  }

  if (installment.paidAmountCents == null) return 0;
  return Math.max(0, installment.baseAmountCents - installment.paidAmountCents);
}

function paymentStatusSource(status: MonthlyPaymentStatus): MonthlyPaymentStatusSource {
  if (status === "paid") return "erp_explicit";
  if (status === "agreed") return "erp_agreed";
  if (status === "excluded") return "erp_excluded";
  return "erp_open_invoice";
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

  const pendingInstallments = installments
    .map((installment) => ({
      installment,
      pendingAmountCents: pendingAmountForInstallment(installment)
    }))
    .filter((item) => item.pendingAmountCents > 0);

  const grouped = new Map<string, { installmentsCount: number; totalAmountCents: number }>();
  for (const { installment, pendingAmountCents } of pendingInstallments) {
    const current = grouped.get(installment.planType) ?? {
      installmentsCount: 0,
      totalAmountCents: 0
    };
    current.installmentsCount += 1;
    current.totalAmountCents += pendingAmountCents;
    grouped.set(installment.planType, current);
  }

  const targetInstallment = installments.find(
    (installment) => installment.installmentCode === targetId
  );
  if (!targetInstallment) {
    throw new MonthlyResponseError(
      `A parcela alvo ${targetId} foi classificada, mas nao foi materializada na analise.`
    );
  }

  const targetPendingAmountCents = pendingAmountForInstallment(targetInstallment);
  const targetPaymentStatus = targetState.status;
  const targetPaymentStatusSource = paymentStatusSource(targetPaymentStatus);
  const targetPaymentAmountCents = targetPaymentStatus === "paid"
    ? targetInstallment.paidAmountCents
    : 0;

  if (targetPaymentStatus === "paid" && targetPaymentAmountCents == null) {
    throw new MonthlyResponseError(
      `A parcela paga ${targetId} nao possui ValorPago materializado na analise.`
    );
  }

  return {
    paymentStatus: targetPaymentStatus,
    paymentStatusSource: targetPaymentStatusSource,
    targetFinancialState: {
      installmentCode: targetId,
      paymentStatus: targetPaymentStatus,
      paymentStatusSource: targetPaymentStatusSource,
      installmentAmountCents: targetInstallment.baseAmountCents,
      paymentAmountCents: targetPaymentAmountCents ?? 0,
      pendingAmountCents:
        targetPaymentStatus === "agreed" || targetPaymentStatus === "excluded"
          ? 0
          : targetPendingAmountCents
    },
    message:
      payload.message ||
      (targetPaymentStatus === "excluded"
        ? "Parcela excluida conforme DescricaoRecebimento do ERP."
        : targetPaymentStatus === "agreed"
          ? "Parcela acordada conforme DescricaoRecebimento do ERP."
          : targetPaymentStatus === "paid"
            ? targetPendingAmountCents > 0
              ? "Parcela paga com pendencia conforme DescricaoRecebimento e ValorPago do ERP."
              : "Parcela paga conforme DescricaoRecebimento e ValorPago do ERP."
            : "Parcela em aberto conforme DescricaoRecebimento do ERP."),
    installmentsCount: installments.length,
    totalPendingAmountCents: pendingInstallments.reduce(
      (sum, item) => sum + item.pendingAmountCents,
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
    // O ERP informa PageSize como a quantidade efetivamente retornada na pagina.
    // Assim, a ultima pagina pode ter PageSize menor (ex.: 200 + 24 de um total de 224).
    // TotalPages e TotalCount continuam sendo metadados globais e devem permanecer estaveis.
    if (
      page.totalPages !== expectedTotalPages ||
      page.totalCount !== expectedTotalCount
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
