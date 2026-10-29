import { describe, expect, it } from "vitest";
import { extractErpMobileContacts, normalizeBrazilianMobile, topThreeMobileContacts } from "@/lib/member-contacts";
import { buildAssociadosWorkbook } from "@/lib/export-workbooks";

describe("contatos de associados", () => {
  it("normaliza somente celulares brasileiros e não duplica o código do país", () => {
    expect(normalizeBrazilianMobile("(85)99642.9155")).toBe("5585996429155");
    expect(normalizeBrazilianMobile("5585996429155")).toBe("5585996429155");
    expect(normalizeBrazilianMobile("(85)3225.9656")).toBeNull();
    expect(normalizeBrazilianMobile("(08)5328.9217")).toBeNull();
    expect(normalizeBrazilianMobile("(85)99000.0000")).toBe("5585990000000");
  });

  it("relaciona datas por telefone, elimina fixos e seleciona os três mais novos", () => {
    const contacts = extractErpMobileContacts(
      "(85)99642.9155, (85)98709.0722, (85)99657.9234, (85)3225.9656, (85)98953.2923",
      {
        "(85)99642.9155": "14/10/2026",
        "(85)98709.0722": "06/02/2026",
        "(85)99657.9234": "16/04/2025",
        "(85)3225.9656": "10/07/2020",
        "(85)98953.2923": "12/07/2024"
      },
      "625806"
    );
    expect(topThreeMobileContacts(contacts).map(({ phone, updatedAt }) => [phone, updatedAt]))
      .toEqual([
        ["5585996429155", "2026-10-14"],
        ["5585987090722", "2026-02-06"],
        ["5585996579234", "2025-04-16"]
      ]);
    expect(contacts.every((contact) => contact.invoiceNumber === "625806")).toBe(true);
  });

  it("adiciona a aba Contatos com CPF integral e números como texto sem alterar Associados", () => {
    const workbook = buildAssociadosWorkbook({
      rows: [], filters: [],
      contactRows: [{
        cpf: "01234567890", name: "Exemplo", phone: "5585996429155",
        date: "14/10/2026", invoiceNumber: "625806"
      }]
    });
    expect(workbook.SheetNames).toEqual(["Associados", "Contatos"]);
    const sheet = workbook.Sheets.Contatos;
    expect([sheet.A1.v, sheet.B1.v, sheet.C1.v, sheet.D1.v, sheet.E1.v])
      .toEqual(["CPF", "Nome", "Telefone", "Data", "Nº da fatura"]);
    expect(sheet.A2).toMatchObject({ t: "s", v: "01234567890" });
    expect(sheet.C2).toMatchObject({ t: "s", v: "5585996429155" });
    expect(sheet.E2).toMatchObject({ t: "s", v: "625806" });
  });
});
