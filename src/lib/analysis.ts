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
    ValorFinal: NullableStringOrNumberSchema
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
  message: string;
  installmentsCount: number;
  totalPendingAmountCents: number;
  totalsByPlan: Array<{
    planType: string;
    installmentsCount: number;
    totalAmountCents: number;
  }>;
  installments: MonthlyInstallment[];
  warnings: string[];
};

type NormalizedLegacyPayload = {
  source: "legacy";
  message?: string;
  parcels: z.infer<typeof MonthlyParcelSchema>[];
};

type NormalizedPaginatedPayload = {
  source: "paginated";
  message?: string;
  items: z.infer<typeof MonthlyApiDataItemSchema>[];
};

function optionalText(value: unknown) {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function monetaryValue(value: unknown, field: string, warnings: string[]) {
  const result = toCents(value);
  if (result.warning && value != null && String(value).trim() !== "") {
    warnings.push(`${field}: ${result.warning}`);
  }
  return result.cents;
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
    return {
      source: "paginated",
      message: paginated.data.mensagem?.trim(),
      items: paginated.data.dados.Data
    };
  }

  throw new MonthlyResponseError(
    "A resposta do ERP não possui o contrato esperado."
  );
}

function analyzeLegacyPayload(payload: NormalizedLegacyPayload): MonthlyAnalysis {
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
      dueDate: optionalText(item.vencimento),
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
      observation: optionalText(item.Observacao)
    });
  }

  if (installments.length === 0) {
    return {
      paymentStatus: "paid",
      message: payload.message || "Associado sem mensalidades em aberto.",
      installmentsCount: 0,
      totalPendingAmountCents: 0,
      totalsByPlan: [],
      installments: [],
      warnings
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
    message: payload.message || "Associado possui mensalidades em aberto.",
    installmentsCount: installments.length,
    totalPendingAmountCents: installments.reduce((sum, installment) => sum + installment.finalAmountCents, 0),
    totalsByPlan: [...grouped.entries()].map(([planType, total]) => ({ planType, ...total })),
    installments,
    warnings
  };
}

function analyzePaginatedPayload(
  payload: NormalizedPaginatedPayload,
  targetInstallmentId?: string
): MonthlyAnalysis {
  if (!targetInstallmentId) {
    throw new MonthlyResponseError(
      "A análise da API de mensalidades exige a parcela de destino."
    );
  }

  const matched = payload.items.find((item) => optionalText(item.Id) === targetInstallmentId);
  if (!matched) {
    return {
      paymentStatus: "paid",
      message: payload.message || "Parcela não localizada para o associado informado.",
      installmentsCount: 0,
      totalPendingAmountCents: 0,
      totalsByPlan: [],
      installments: [],
      warnings: []
    };
  }

  const finalAmount = toCents(matched.ValorFinal);
  if (finalAmount.warning) {
    throw new MonthlyResponseError(
      `A parcela ${targetInstallmentId} possui ValorFinal inválido.`
    );
  }

  return {
    paymentStatus: "unpaid",
    message: payload.message || "Parcela localizada como pendente.",
    installmentsCount: 1,
    totalPendingAmountCents: finalAmount.cents,
    totalsByPlan: [
      {
        planType: "Não informado",
        installmentsCount: 1,
        totalAmountCents: finalAmount.cents
      }
    ],
    installments: [
      {
        installmentCode: targetInstallmentId,
        baseAmountCents: finalAmount.cents,
        fineAmountCents: 0,
        interestAmountCents: 0,
        additionalAmountCents: 0,
        discountAmountCents: 0,
        finalAmountCents: finalAmount.cents,
        planType: "Não informado"
      }
    ],
    warnings: []
  };
}

export function analyzeMonthlyResponse(
  input: unknown,
  targetInstallmentId?: string
): MonthlyAnalysis {
  const normalized = normalizeMonthlyPayload(input);
  if (normalized.source === "paginated") {
    return analyzePaginatedPayload(normalized, targetInstallmentId);
  }
  return analyzeLegacyPayload(normalized);
}
