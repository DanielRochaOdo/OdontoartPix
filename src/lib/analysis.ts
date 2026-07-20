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

const MonthlyResponseSchema = z
  .object({
    mensagem: z.string().nullish(),
    parcelas: z.array(MonthlyParcelSchema)
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

export function analyzeMonthlyResponse(input: unknown): MonthlyAnalysis {
  const parsed = MonthlyResponseSchema.safeParse(input);
  if (!parsed.success) {
    throw new MonthlyResponseError(
      "A resposta do ERP não possui o contrato esperado com parcelas em formato de array."
    );
  }

  const warnings: string[] = [];
  const seen = new Set<string>();
  const installments: MonthlyInstallment[] = [];

  for (const item of parsed.data.parcelas) {
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
      installmentType: optionalText(item.tipo_parcela),
      boletoCode: optionalText(item.cod_boleto),
      pixCode: optionalText(item.cod_pix),
      cardPaymentLink: optionalText(item.link_cartão),
      situation: optionalText(item.Situacao),
      baseAmountCents: monetaryValue(item.Valor, "Valor", warnings),
      fineAmountCents: monetaryValue(item.Multa, "Multa", warnings),
      interestAmountCents: monetaryValue(item.Juros, "Juros", warnings),
      additionalAmountCents: monetaryValue(
        item.AcrescimoAvulso,
        "AcrescimoAvulso",
        warnings
      ),
      discountAmountCents: monetaryValue(
        item.DescontoAvulso,
        "DescontoAvulso",
        warnings
      ),
      finalAmountCents: finalAmount.cents,
      planType: optionalText(item.Tipo_plano) ?? "Não informado",
      observation: optionalText(item.Observacao)
    });
  }

  if (installments.length === 0) {
    return {
      paymentStatus: "paid",
      message: parsed.data.mensagem?.trim() || "Associado sem mensalidades em aberto.",
      installmentsCount: 0,
      totalPendingAmountCents: 0,
      totalsByPlan: [],
      installments: [],
      warnings
    };
  }

  const grouped = new Map<
    string,
    { installmentsCount: number; totalAmountCents: number }
  >();

  for (const installment of installments) {
    const current = grouped.get(installment.planType) ?? {
      installmentsCount: 0,
      totalAmountCents: 0
    };
    current.installmentsCount += 1;
    current.totalAmountCents += installment.finalAmountCents;
    grouped.set(installment.planType, current);
  }

  const totalsByPlan = [...grouped.entries()].map(([planType, total]) => ({
    planType,
    ...total
  }));
  const totalPendingAmountCents = installments.reduce(
    (sum, installment) => sum + installment.finalAmountCents,
    0
  );

  return {
    paymentStatus: "unpaid",
    message: parsed.data.mensagem?.trim() || "Associado possui mensalidades em aberto.",
    installmentsCount: installments.length,
    totalPendingAmountCents,
    totalsByPlan,
    installments,
    warnings
  };
}
