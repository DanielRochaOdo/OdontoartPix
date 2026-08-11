import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseMemberFile, parseMemberUpdateFile } from "@/lib/imports";

describe("parseMemberFile", () => {
  it("recognizes CodigoAssociadoEmpresa, Parcela, Valor da Parcela, Nome and CPF columns", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([
      {
        CodigoAssociadoEmpresa: "A-123",
        Parcela: "P-9",
        "Valor da Parcela": "87,42",
        Nome: "Maria de Teste",
        CPF: "529.982.247-25"
      }
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Base");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await parseMemberFile(new File([buffer], "modelo.xlsx"));

    expect(result.issues).toEqual([]);
    expect(result.imports).toEqual([
      expect.objectContaining({
        associatedCode: "A-123",
        targetInstallmentId: "P-9",
        installmentAmountCents: 8742,
        cpf: "52998224725",
        name: "Maria de Teste"
      })
    ]);
  });

  it("reads Data de Vencimento from the upload", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([
      {
        CodigoAssociadoEmpresa: "A-123",
        Parcela: "P-9",
        "Valor da Parcela": "87,42",
        "Data de Vencimento": "15/08/2026"
      }
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Base");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await parseMemberFile(new File([buffer], "modelo.xlsx"));

    expect(result.imports[0]).toEqual(expect.objectContaining({ dueDate: "15/08/2026" }));
  });

  it("accepts numeric CodigoAssociadoEmpresa, Parcela and Valor da Parcela in XLSX", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Nome", "CodigoAssociadoEmpresa", "Parcela", "Valor da Parcela", "CPF"],
      ["Pessoa Numerica", 4100406304, 55, 91.3, ""]
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Base");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await parseMemberFile(new File([buffer], "modelo.xlsx"));

    expect(result.issues).toEqual([]);
    expect(result.imports[0]).toEqual(
      expect.objectContaining({
        associatedCode: "4100406304",
        targetInstallmentId: "55",
        installmentAmountCents: 9130
      })
    );
  });

  it("accepts spacing and accent variations in headers", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([
      {
        " Codigo associado ": "COD-77",
        " Parcela ": "1",
        " Valor da Parcela ": "120,55",
        "Nome completo": "Joao de Teste",
        " CPF ": "04100406304"
      }
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Base");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await parseMemberFile(new File([buffer], "modelo.xlsx"));

    expect(result.imports[0]).toEqual(
      expect.objectContaining({
        associatedCode: "COD-77",
        targetInstallmentId: "1",
        installmentAmountCents: 12055,
        cpf: "04100406304",
        name: "Joao de Teste"
      })
    );
  });

  it("marks the row as invalid when Valor da Parcela is missing", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Nome", "CodigoAssociadoEmpresa", "Parcela", "Valor da Parcela", "CPF"],
      ["Sem Valor", "COD-1", "33", "", ""]
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Base");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await parseMemberFile(new File([buffer], "modelo.xlsx"));

    expect(result.imports).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        reason: "Valor da Parcela ausente ou invalido."
      })
    ]);
  });
});

describe("parseMemberUpdateFile", () => {
  it("requires only CodigoAssociadoEmpresa and accepts any populated update column", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Nome", "CodigoAssociadoEmpresa", "Parcela", "Valor da Parcela", "CPF", "Vencimento"],
      ["Novo Nome", "A-123", "P-9", "", "", "15/08/2026"]
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Modelo");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await parseMemberUpdateFile(new File([buffer], "atualizacao.xlsx"));

    expect(result.issues).toEqual([]);
    expect(result.updates[0]).toEqual(expect.objectContaining({
      associatedCode: "A-123",
      name: "Novo Nome",
      dueDate: "15/08/2026"
    }));
  });

  it("requires CodigoAssociadoEmpresa and Parcela", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Nome", "CodigoAssociadoEmpresa", "Parcela", "Valor da Parcela", "CPF", "Vencimento"],
      ["Novo Nome", "A-123", "", "", "", "15/08/2026"]
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Modelo");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await parseMemberUpdateFile(new File([buffer], "atualizacao.xlsx"));

    expect(result.updates).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ associatedCode: "A-123", reason: "Parcela ausente." })
    ]);
  });
});
