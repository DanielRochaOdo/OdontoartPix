import * as XLSX from "xlsx";

export type ExportFilter = {
  label: string;
  value: string;
};

export type AssociadosExportRow = {
  name: string;
  associatedCode: string;
  installment: string;
  dueDate: string;
  cpf: string;
  campaign: string;
  batch: string;
  status: string;
  payment: string;
  receiptDescription: string;
  installmentType: string;
  paymentDate: string;
  amountCents: number;
  paidAmountCents: number | null;
  pendingCents: number;
};

export type SummaryExportEntity = {
  dispatchCount: number;
  dispatchValueCents: number;
  actionCostCents: number;
  paidAssociateCount: number;
  paidInstallmentCount: number;
  paidAmountCents: number;
  paidAssociatePercentage: number;
  paidInstallmentPercentage: number;
  paidPercentage: number;
  netAmountCents: number;
};

export type SummaryPixExportEntity = {
  dispatchValueCents: number;
  paidAssociateCount: number;
  paidInstallmentCount: number;
  paidAmountCents: number;
};

const ACCOUNTING_FORMAT = '"R$" #,##0.00;[Red]-"R$" #,##0.00;"R$" -';
const PERCENT_FORMAT = "0.00%";

const titleStyle = {
  font: { bold: true, color: { rgb: "E6FFFA" }, sz: 16 },
  fill: { fgColor: { rgb: "062B2B" } },
  alignment: { vertical: "center" }
};
const subtitleStyle = {
  font: { color: { rgb: "527B80" }, sz: 11 }
};
const sectionStyle = {
  font: { bold: true, color: { rgb: "0F766E" } },
  fill: { fgColor: { rgb: "CCFBF1" } }
};
const tableHeaderStyle = {
  font: { bold: true, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "0F766E" } },
  alignment: { vertical: "center" }
};
const cardHeaderStyle = {
  font: { bold: true, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "0F766E" } },
  alignment: { vertical: "center", horizontal: "left" }
};
const cardLabelStyle = {
  font: { color: { rgb: "527B80" }, sz: 10 },
  fill: { fgColor: { rgb: "F4FBFA" } }
};
const cardValueStyle = {
  font: { bold: true, color: { rgb: "102F35" }, sz: 11 },
  fill: { fgColor: { rgb: "F4FBFA" } }
};

function setStyle(worksheet: XLSX.WorkSheet, ref: string, style: unknown) {
  const cell = worksheet[ref];
  if (cell) cell.s = style;
}

function setNumberFormat(worksheet: XLSX.WorkSheet, ref: string, format: string) {
  const cell = worksheet[ref];
  if (cell && cell.t === "n") cell.z = format;
}

function generatedLabel(date: Date) {
  return `Gerado em ${new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date)}`;
}

export function buildAssociadosWorkbook({
  rows,
  filters,
  generatedAt = new Date()
}: {
  rows: AssociadosExportRow[];
  filters: ExportFilter[];
  generatedAt?: Date;
}) {
  const headers = [
    "Nome",
    "Código associado",
    "Parcela",
    "Vencimento",
    "CPF",
    "Campanha",
    "Lote",
    "Status",
    "Pagamento",
    "Tipo de pagamento",
    "Tipo de parcela",
    "Data de pagamento",
    "Valor (R$)",
    "Valor pago (R$)",
    "Pendência (R$)"
  ];
  const metadataRows: (string | number | null)[][] = [
    ["ODONTOPIX · ASSOCIADOS"],
    ["Exportação dos registros filtrados"],
    [generatedLabel(generatedAt)],
    [],
    ["FILTROS APLICADOS", "CRITÉRIO"],
    ...filters.map((filter) => [filter.label, filter.value]),
    [],
    [`${new Intl.NumberFormat("pt-BR").format(rows.length)} registro(s) exportado(s)`],
    [],
    headers
  ];
  const headerRow = metadataRows.length;
  const firstDataRow = headerRow + 1;
  const lastDataRow = headerRow + rows.length;
  const worksheet = XLSX.utils.aoa_to_sheet(metadataRows);

  XLSX.utils.sheet_add_aoa(
    worksheet,
    rows.map((row) => [
      row.name,
      row.associatedCode,
      row.installment,
      row.dueDate,
      row.cpf,
      row.campaign,
      row.batch,
      row.status,
      row.payment,
      row.receiptDescription,
      row.installmentType,
      row.paymentDate,
      row.amountCents / 100,
      row.paidAmountCents == null ? null : row.paidAmountCents / 100,
      row.pendingCents / 100
    ]),
    { origin: `A${firstDataRow}` }
  );

  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 14 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 14 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 14 } },
    { s: { r: headerRow - 3, c: 0 }, e: { r: headerRow - 3, c: 14 } }
  ];
  worksheet["!autofilter"] = { ref: `A${headerRow}:O${Math.max(headerRow, lastDataRow)}` };
  worksheet["!cols"] = [
    { wch: 32 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 26 },
    { wch: 26 }, { wch: 22 }, { wch: 22 }, { wch: 30 }, { wch: 18 }, { wch: 20 },
    { wch: 18 }, { wch: 18 }, { wch: 18 }
  ];
  worksheet["!rows"] = [{ hpt: 28 }, { hpt: 22 }, { hpt: 18 }];

  setStyle(worksheet, "A1", titleStyle);
  setStyle(worksheet, "A2", subtitleStyle);
  setStyle(worksheet, "A5", sectionStyle);
  setStyle(worksheet, "B5", sectionStyle);
  for (let column = 0; column < headers.length; column += 1) {
    setStyle(worksheet, XLSX.utils.encode_cell({ r: headerRow - 1, c: column }), tableHeaderStyle);
  }
  for (const column of ["M", "N", "O"]) {
    for (let row = firstDataRow; row <= lastDataRow; row += 1) {
      setNumberFormat(worksheet, `${column}${row}`, ACCOUNTING_FORMAT);
    }
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Associados");
  return workbook;
}

function addSummaryCard(
  worksheet: XLSX.WorkSheet,
  startCol: number,
  startRow: number,
  title: string,
  entity: SummaryExportEntity
) {
  const metrics: Array<[string, number, "currency" | "percent" | "count"]> = [
    ["Qtde disparos", entity.dispatchCount, "count"],
    ["Valor disparos", entity.dispatchValueCents / 100, "currency"],
    ["Custo ação", entity.actionCostCents / 100, "currency"],
    ["Assoc. pagos", entity.paidAssociateCount, "count"],
    ["% assoc. pagos", entity.paidAssociatePercentage / 100, "percent"],
    ["Parcelas pagas", entity.paidInstallmentCount, "count"],
    ["% parcelas pagas", entity.paidInstallmentPercentage / 100, "percent"],
    ["Pago", entity.paidAmountCents / 100, "currency"],
    ["% pago", entity.paidPercentage / 100, "percent"],
    ["Líquido", entity.netAmountCents / 100, "currency"]
  ];

  XLSX.utils.sheet_add_aoa(worksheet, [[title]], { origin: { r: startRow, c: startCol } });
  worksheet["!merges"]!.push({ s: { r: startRow, c: startCol }, e: { r: startRow, c: startCol + 3 } });
  setStyle(worksheet, XLSX.utils.encode_cell({ r: startRow, c: startCol }), cardHeaderStyle);

  metrics.forEach(([label, value, kind], index) => {
    const row = startRow + index + 1;
    XLSX.utils.sheet_add_aoa(worksheet, [[label, value]], { origin: { r: row, c: startCol } });
    worksheet["!merges"]!.push({ s: { r: row, c: startCol + 1 }, e: { r: row, c: startCol + 3 } });
    const labelRef = XLSX.utils.encode_cell({ r: row, c: startCol });
    const valueRef = XLSX.utils.encode_cell({ r: row, c: startCol + 1 });
    setStyle(worksheet, labelRef, cardLabelStyle);
    setStyle(worksheet, valueRef, cardValueStyle);
    if (kind === "currency") setNumberFormat(worksheet, valueRef, ACCOUNTING_FORMAT);
    if (kind === "percent") setNumberFormat(worksheet, valueRef, PERCENT_FORMAT);
  });
}

function addPixCard(
  worksheet: XLSX.WorkSheet,
  startCol: number,
  startRow: number,
  title: string,
  entity: SummaryPixExportEntity
) {
  const metrics: Array<[string, number, "currency" | "count"]> = [
    ["Valor das parcelas", entity.dispatchValueCents / 100, "currency"],
    ["Associados pagos", entity.paidAssociateCount, "count"],
    ["Parcelas pagas", entity.paidInstallmentCount, "count"],
    ["Recebido via PIX", entity.paidAmountCents / 100, "currency"]
  ];
  XLSX.utils.sheet_add_aoa(worksheet, [[title]], { origin: { r: startRow, c: startCol } });
  worksheet["!merges"]!.push({ s: { r: startRow, c: startCol }, e: { r: startRow, c: startCol + 7 } });
  setStyle(worksheet, XLSX.utils.encode_cell({ r: startRow, c: startCol }), cardHeaderStyle);
  metrics.forEach(([label, value, kind], index) => {
    const row = startRow + index + 1;
    XLSX.utils.sheet_add_aoa(worksheet, [[label, value]], { origin: { r: row, c: startCol } });
    worksheet["!merges"]!.push({ s: { r: row, c: startCol + 1 }, e: { r: row, c: startCol + 7 } });
    const labelRef = XLSX.utils.encode_cell({ r: row, c: startCol });
    const valueRef = XLSX.utils.encode_cell({ r: row, c: startCol + 1 });
    setStyle(worksheet, labelRef, cardLabelStyle);
    setStyle(worksheet, valueRef, cardValueStyle);
    if (kind === "currency") setNumberFormat(worksheet, valueRef, ACCOUNTING_FORMAT);
  });
}

export function buildSummaryAnalysisWorkbook({
  filters,
  clinico,
  orto,
  combined,
  robo,
  roboClinico,
  roboOrto,
  generatedAt = new Date()
}: {
  filters: ExportFilter[];
  clinico: SummaryExportEntity;
  orto: SummaryExportEntity;
  combined: SummaryExportEntity;
  robo: SummaryExportEntity;
  roboClinico: SummaryPixExportEntity;
  roboOrto: SummaryPixExportEntity;
  generatedAt?: Date;
}) {
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["ODONTOPIX · RESUMO E ANÁLISE"],
    ["Visão consolidada dos resultados operacionais"],
    [generatedLabel(generatedAt)],
    [],
    ["FILTROS APLICADOS", "CRITÉRIO"],
    ...filters.map((filter) => [filter.label, filter.value])
  ]);
  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 15 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 15 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 15 } }
  ];
  worksheet["!cols"] = Array.from({ length: 16 }, (_, index) => ({ wch: index % 4 === 0 ? 20 : 11 }));
  worksheet["!rows"] = [{ hpt: 28 }, { hpt: 22 }, { hpt: 18 }];
  setStyle(worksheet, "A1", titleStyle);
  setStyle(worksheet, "A2", subtitleStyle);
  setStyle(worksheet, "A5", sectionStyle);
  setStyle(worksheet, "B5", sectionStyle);

  const cardRow = filters.length + 7;
  addSummaryCard(worksheet, 0, cardRow, "CLÍNICO", clinico);
  addSummaryCard(worksheet, 4, cardRow, "ORTO", orto);
  addSummaryCard(worksheet, 8, cardRow, "CLÍNICO + ORTO", combined);
  addSummaryCard(worksheet, 12, cardRow, "ROBÔ · PIX", robo);

  const pixHeaderRow = cardRow + 13;
  XLSX.utils.sheet_add_aoa(worksheet, [["ROBÔ · PIX POR TIPO DE PARCELA"]], { origin: { r: pixHeaderRow, c: 0 } });
  worksheet["!merges"].push({ s: { r: pixHeaderRow, c: 0 }, e: { r: pixHeaderRow, c: 15 } });
  setStyle(worksheet, XLSX.utils.encode_cell({ r: pixHeaderRow, c: 0 }), sectionStyle);
  addPixCard(worksheet, 0, pixHeaderRow + 2, "CLÍNICO · PIX", roboClinico);
  addPixCard(worksheet, 8, pixHeaderRow + 2, "ORTO · PIX", roboOrto);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Resumo e Análise");
  return workbook;
}

export const EXPORT_ACCOUNTING_FORMAT = ACCOUNTING_FORMAT;
