import * as XLSX from "xlsx";
import { requireApiUser } from "@/lib/auth/require-api-user";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[
    "Nome",
    "CodigoAssociadoEmpresa",
    "Parcela",
    "Valor da Parcela",
    "CPF",
    "Vencimento"
  ]]);
  sheet["!cols"] = [{ wch: 32 }, { wch: 28 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  sheet["!autofilter"] = { ref: "A1:F1" };
  sheet["!freeze"] = { xSplit: 0, ySplit: 1 };

  const instructions = XLSX.utils.aoa_to_sheet([
    ["Instrucoes para atualizacao de associados"],
    ["CodigoAssociadoEmpresa e obrigatorio e nao pode ser alterado."],
    ["CodigoAssociadoEmpresa e Parcela sao obrigatorios em todas as linhas."],
    ["Preencha somente as colunas dos dados que deseja atualizar, mantendo o CodigoAssociadoEmpresa e a Parcela."],
    ["Nome e CPF atualizam o cadastro do associado."],
    ["Parcela identifica o vinculo correspondente; Valor da Parcela e Vencimento atualizam esse vinculo."],
    ["A atualizacao e feita diretamente no banco e nao consulta o ERP."],
    ["A Parcela deve ser a parcela existente do associado e sera usada para localizar o vinculo exato."],
    ["Nao altere os nomes das colunas da aba Modelo."]
  ]);
  instructions["!cols"] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(workbook, sheet, "Modelo");
  XLSX.utils.book_append_sheet(workbook, instructions, "Instrucoes");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="modelo-atualizacao-associados.xlsx"',
      "Cache-Control": "no-store"
    }
  });
}
