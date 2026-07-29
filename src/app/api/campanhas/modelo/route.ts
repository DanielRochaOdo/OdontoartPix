import * as XLSX from "xlsx";
import { requireApiUser } from "@/lib/auth/require-api-user";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const workbook = XLSX.utils.book_new();
  const modelSheet = XLSX.utils.aoa_to_sheet([[
    "Nome",
    "CodigoAssociadoEmpresa",
    "Parcela",
    "Valor da Parcela",
    "CPF"
  ]]);
  modelSheet["!cols"] = [{ wch: 38 }, { wch: 28 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  modelSheet["!autofilter"] = { ref: "A1:E1" };
  modelSheet["!freeze"] = { xSplit: 0, ySplit: 1 };

  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ["Instrucoes para importacao"],
    ["Preencha uma linha por associado na aba Modelo."],
    ["Use exatamente as colunas Nome, CodigoAssociadoEmpresa, Parcela, Valor da Parcela e CPF."],
    ["CodigoAssociadoEmpresa, Parcela e Valor da Parcela sao obrigatorios."],
    ["CPF e opcional e serve apenas para conferencia interna."],
    ["Nome e opcional e serve apenas para conferencia interna."],
    ["CodigoAssociadoEmpresa e o identificador usado pela API externa."],
    ["Parcela sera comparada com o campo Id retornado pela API."],
    ["Valor da Parcela sera usado quando a API indicar que a parcela esta paga."],
    ["Se a API retornar ValorFinal para parcela em aberto, o sistema atualizara o valor conforme o ERP."],
    ["Nao altere os nomes das colunas da aba Modelo."]
  ]);
  instructionsSheet["!cols"] = [{ wch: 96 }];

  XLSX.utils.book_append_sheet(workbook, modelSheet, "Modelo");
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "Instrucoes");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return new Response(buffer, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="modelo-importacao-campanha.xlsx"',
      "Cache-Control": "no-store"
    }
  });
}
