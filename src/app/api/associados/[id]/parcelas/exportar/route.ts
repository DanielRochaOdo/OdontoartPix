import * as XLSX from "xlsx";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getMemberDetail } from "@/lib/data";
import { sortInstallmentsNewestFirst } from "@/lib/installment-history";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

const STATUS_LABELS: Record<string, string> = {
  aguardando: "Aguardando",
  completed: "Concluído",
  concluido: "Concluído",
  concluída: "Concluída",
  erro: "Erro",
  error: "Erro",
  em_aberto: "Em aberto",
  emaberto: "Em aberto",
  open: "Em aberto",
  opened: "Em aberto",
  paid: "Pago",
  pago: "Pago",
  pending: "Pendente",
  pendente: "Pendente",
  processing: "Processando",
  processando: "Processando",
  retrying: "Reprocessando",
  unpaid: "Não pago",
  "nao pago": "Não pago",
  "não pago": "Não pago"
};

function translateStatus(value: string | null | undefined) {
  if (!value) return "-";
  const normalized = value.trim().toLowerCase();
  return STATUS_LABELS[normalized] ?? value;
}

function safeFilePart(value: string | null | undefined) {
  const normalized = value?.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "associado";
}

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return Response.json({ error: "Associado inválido." }, { status: 400 });
  }

  const detail = await getMemberDetail(parsed.data.id);
  if (!detail) {
    return Response.json({ error: "Associado não encontrado." }, { status: 404 });
  }

  const installments = sortInstallmentsNewestFirst(detail.installments);
  const member = detail.link.member;

  const rows = [
    [
      "Parcela",
      "Vencimento",
      "Tipo",
      "Plano",
      "Situação",
      "Valor base",
      "Encargos",
      "Desconto",
      "Valor final"
    ],
    ...installments.map((installment) => [
      installment.cod_parcela ?? "-",
      installment.due_date_text ?? "-",
      installment.installment_type ?? "-",
      installment.plan_type || "Não informado",
      translateStatus(installment.situation),
      Number(installment.base_amount_cents ?? 0) / 100,
      (
        Number(installment.fine_amount_cents ?? 0) +
        Number(installment.interest_amount_cents ?? 0) +
        Number(installment.additional_amount_cents ?? 0)
      ) / 100,
      Number(installment.discount_amount_cents ?? 0) / 100,
      Number(installment.final_amount_cents ?? 0) / 100
    ])
  ];

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [
    { wch: 18 },
    { wch: 16 },
    { wch: 20 },
    { wch: 24 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 }
  ];
  sheet["!autofilter"] = { ref: `A1:I${Math.max(1, rows.length)}` };
  sheet["!freeze"] = { xSplit: 0, ySplit: 1 };

  for (let row = 2; row <= rows.length; row += 1) {
    for (const column of ["F", "G", "H", "I"]) {
      const cell = sheet[`${column}${row}`];
      if (cell) cell.z = 'R$ #,##0.00';
    }
  }

  XLSX.utils.book_append_sheet(workbook, sheet, "Parcelas financeiras");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const identifier = safeFilePart(member?.external_user_code ?? member?.name ?? parsed.data.id);

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="parcelas-${identifier}.xlsx"`,
      "Cache-Control": "no-store"
    }
  });
}
