import { z } from "zod";
import { toCents } from "@/lib/money";

const MonthlyParcelSchema = z.object({
  cod_usuario: z.union([z.string(), z.number()]).optional(),
  cod_parcela: z.union([z.string(), z.number()]).optional(),
  vencimento: z.string().optional(),
  tipo_parcela: z.string().optional(),
  Situacao: z.string().optional(),
  Tipo_plano: z.string().optional(),
  ValorFinal: z.union([z.string(), z.number()]).optional(),
  Valor: z.union([z.string(), z.number()]).optional(),
  Multa: z.union([z.string(), z.number()]).optional(),
  Juros: z.union([z.string(), z.number()]).optional(),
  AcrescimoAvulso: z.union([z.string(), z.number()]).optional(),
  DescontoAvulso: z.union([z.string(), z.number()]).optional()
});

const MonthlyResponseSchema = z.object({
  mensagem: z.string().optional(),
  parcelas: z.array(MonthlyParcelSchema).optional()
});

export type MonthlyAnalysis = {
  paymentStatus: "paid" | "unpaid";
  message: string;
  installmentsCount: number;
  totalPendingAmountCents: number;
  totalsByPlan: Array<{ planType: string; installmentsCount: number; totalAmountCents: number }>;
  installments: Array<{ userCode?: string; installmentCode: string; dueDate?: string; installmentType?: string; planType: string; finalAmountCents: number }>;
  warnings: string[];
};

export function analyzeMonthlyResponse(input: unknown): MonthlyAnalysis {
  const parsed = MonthlyResponseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      paymentStatus: "unpaid",
      message: "Resposta inválida ou sem o campo parcelas.",
      installmentsCount: 0,
      totalPendingAmountCents: 0,
      totalsByPlan: [],
      installments: [],
      warnings: ["Resposta externa inválida."]
    };
  }

  const parcelas = parsed.data.parcelas ?? [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const installments = parcelas.filter((item) => item.cod_parcela != null).flatMap((item) => {
    const installmentCode = String(item.cod_parcela);
    const userCode = item.cod_usuario == null ? undefined : String(item.cod_usuario);
    const dedupeKey = `${userCode ?? ""}:${installmentCode}`;
    if (seen.has(dedupeKey)) return [];
    seen.add(dedupeKey);

    const { cents, warning } = toCents(item.ValorFinal);
    if (warning) warnings.push(warning);

    return [{
      userCode,
      installmentCode,
      dueDate: item.vencimento,
      installmentType: item.tipo_parcela,
      planType: item.Tipo_plano?.trim() || "Não informado",
      finalAmountCents: cents
    }];
  });

  if (installments.length === 0) {
    return {
      paymentStatus: "paid",
      message: "Associado efetuou pagamento!",
      installmentsCount: 0,
      totalPendingAmountCents: 0,
      totalsByPlan: [],
      installments: [],
      warnings
    };
  }

  const grouped = new Map<string, { installmentsCount: number; totalAmountCents: number }>();
  for (const item of installments) {
    const current = grouped.get(item.planType) ?? { installmentsCount: 0, totalAmountCents: 0 };
    current.installmentsCount += 1;
    current.totalAmountCents += item.finalAmountCents;
    grouped.set(item.planType, current);
  }

  const totalsByPlan = [...grouped.entries()].map(([planType, total]) => ({ planType, ...total }));
  const totalPendingAmountCents = installments.reduce((sum, item) => sum + item.finalAmountCents, 0);

  return {
    paymentStatus: "unpaid",
    message: "Associado possui mensalidades em aberto.",
    installmentsCount: installments.length,
    totalPendingAmountCents,
    totalsByPlan,
    installments,
    warnings
  };
}
