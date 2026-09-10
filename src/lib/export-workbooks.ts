import * as XLSX from "xlsx-js-style";

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
const BORDER_COLOR = "B8CCCC";
const WHITE = "FFFFFF";
const SURFACE = "F4FBFA";
const SURFACE_ALT = "ECF7F5";
const TEAL_DARK = "062B2B";
const TEAL = "0F766E";
const TEAL_SOFT = "CCFBF1";
const TEXT = "102F35";
const MUTED = "527B80";

const thinBorder = {
  top: { style: "thin", color: { rgb: BORDER_COLOR } },
  bottom: { style: "thin", color: { rgb: BORDER_COLOR } },
  left: { style: "thin", color: { rgb: BORDER_COLOR } },
  right: { style: "thin", color: { rgb: BORDER_COLOR } }
};

const titleStyle = {
  font: { bold: true, color: { rgb: "E6FFFA" }, sz: 16 },
  fill: { patternType: "solid", fgColor: { rgb: TEAL_DARK } },
  alignment: { vertical: "center", horizontal: "left" },
  border: thinBorder
};
const subtitleStyle = {
  font: { color: { rgb: MUTED }, sz: 11 },
  fill: { patternType: "solid", fgColor: { rgb: SURFACE } },
  alignment: { vertical: "center" },
  border: thinBorder
};
const infoStyle = {
  font: { color: { rgb: MUTED }, italic: true, sz: 10 },
  fill: { patternType: "solid", fgColor: { rgb: SURFACE } },
  alignment: { vertical: "center" },
  border: thinBorder
};
const sectionStyle = {
  font: { bold: true, color: { rgb: WHITE }, sz: 11 },
  fill: { patternType: "solid", fgColor: { rgb: TEAL } },
  alignment: { vertical: "center", horizontal: "left" },
  border: thinBorder
};
const filterHeaderStyle = {
  font: { bold: true, color: { rgb: WHITE }, sz: 9 },
  fill: { patternType: "solid", fgColor: { rgb: TEAL_DARK } },
  alignment: { vertical: "center", horizontal: "left" },
  border: thinBorder
};
const filterLabelStyle = {
  font: { bold: true, color: { rgb: TEAL }, sz: 9 },
  fill: { patternType: "solid", fgColor: { rgb: TEAL_SOFT } },
  alignment: { vertical: "center", wrapText: true },
  border: thinBorder
};
const filterValueStyle = {
  font: { color: { rgb: TEXT }, sz: 9 },
  fill: { patternType: "solid", fgColor: { rgb: WHITE } },
  alignment: { vertical: "center", wrapText: true },
  border: thinBorder
};
const tableHeaderStyle = {
  font: { bold: true, color: { rgb: WHITE }, sz: 10 },
  fill: { patternType: "solid", fgColor: { rgb: TEAL } },
  alignment: { vertical: "center", horizontal: "center", wrapText: true },
  border: thinBorder
};
const bodyStyle = {
  font: { color: { rgb: TEXT }, sz: 10 },
  fill: { patternType: "solid", fgColor: { rgb: WHITE } },
  alignment: { vertical: "center" },
  border: thinBorder
};
const bodyAltStyle = {
  font: { color: { rgb: TEXT }, sz: 10 },
  fill: { patternType: "solid", fgColor: { rgb: SURFACE_ALT } },
  alignment: { vertical: "center" },
  border: thinBorder
};
const cardHeaderStyle = {
  font: { bold: true, color: { rgb: WHITE }, sz: 11 },
  fill: { patternType: "solid", fgColor: { rgb: TEAL } },
  alignment: { vertical: "center", horizontal: "left" },
  border: thinBorder
};
const cardLabelStyle = {
  font: { bold: true, color: { rgb: MUTED }, sz: 9 },
  fill: { patternType: "solid", fgColor: { rgb: SURFACE_ALT } },
  alignment: { vertical: "center", wrapText: true },
  border: thinBorder
};
const cardValueStyle = {
  font: { bold: true, color: { rgb: TEXT }, sz: 10 },
  fill: { patternType: "solid", fgColor: { rgb: WHITE } },
  alignment: { vertical: "center", horizontal: "right" },
  border: thinBorder
};

function ensureCell(worksheet: XLSX.WorkSheet, ref: string) {
  if (!worksheet[ref]) worksheet[ref] = { t: "s", v: "" };
  return worksheet[ref];
}

function setStyle(worksheet: XLSX.WorkSheet, ref: string, style: unknown) {
  ensureCell(worksheet, ref).s = style;
}

function styleRange(
  worksheet: XLSX.WorkSheet,
  startRow: number,
  endRow: number,
  startCol: number,
  endCol: number,
  style: unknown
) {
  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      setStyle(worksheet, XLSX.utils.encode_cell({ r: row, c: col }), style);
    }
  }
}

function setNumberFormat(worksheet: XLSX.WorkSheet, ref: string, format: string) {
  const cell = worksheet[ref];
  if (cell && cell.t === "n") {
    cell.z = format;
    cell.s = { ...(cell.s ?? {}), numFmt: format };
  }
}

function generatedLabel(date: Date) {
  return `Gerado em ${new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date)}`;
}

function buildFilterRows(filters: ExportFilter[]) {
  const rows: string[][] = [];
  const rowCount = Math.max(1, Math.ceil(filters.length / 3));
  for (let row = 0; row < rowCount; row += 1) {
    const values: string[] = [];
    for (let pair = 0; pair < 3; pair += 1) {
      const filter = filters[row * 3 + pair];
      values.push(filter?.label ?? "", filter?.value ?? "");
    }
    rows.push(values);
  }
  return rows;
}

function styleFilterGrid(worksheet: XLSX.WorkSheet, startRow: number, filterRows: string[][]) {
  styleRange(worksheet, startRow, startRow, 0, 5, sectionStyle);
  styleRange(worksheet, startRow + 1, startRow + 1, 0, 5, filterHeaderStyle);
  for (let row = 0; row < filterRows.length; row += 1) {
    const sheetRow = startRow + 2 + row;
    for (let pair = 0; pair < 3; pair += 1) {
      setStyle(worksheet, XLSX.utils.encode_cell({ r: sheetRow, c: pair * 2 }), filterLabelStyle);
      setStyle(worksheet, XLSX.utils.encode_cell({ r: sheetRow, c: pair * 2 + 1 }), filterValueStyle);
    }
  }
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
  const filterRows = buildFilterRows(filters);
  const metadataRows: (string | number | null)[][] = [
    ["ODONTOPIX · ASSOCIADOS"],
    ["Exportação dos registros filtrados"],
    [generatedLabel(generatedAt)],
    [],
    ["FILTROS APLICADOS"],
    ["FILTRO", "CRITÉRIO", "FILTRO", "CRITÉRIO", "FILTRO", "CRITÉRIO"],
    ...filterRows,
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

  const countRow = 7 + filterRows.length;
  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 14 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 14 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 14 } },
    { s: { r: 4, c: 0 }, e: { r: 4, c: 5 } },
    { s: { r: countRow, c: 0 }, e: { r: countRow, c: 14 } }
  ];
  worksheet["!autofilter"] = { ref: `A${headerRow}:O${Math.max(headerRow, lastDataRow)}` };
  worksheet["!cols"] = [
    { wch: 32 }, { wch: 24 }, { wch: 20 }, { wch: 24 }, { wch: 20 }, { wch: 28 },
    { wch: 26 }, { wch: 22 }, { wch: 22 }, { wch: 30 }, { wch: 18 }, { wch: 20 },
    { wch: 18 }, { wch: 18 }, { wch: 18 }
  ];
  worksheet["!rows"] = [{ hpt: 30 }, { hpt: 22 }, { hpt: 20 }, undefined, { hpt: 22 }, { hpt: 20 }];

  styleRange(worksheet, 0, 0, 0, 14, titleStyle);
  styleRange(worksheet, 1, 1, 0, 14, subtitleStyle);
  styleRange(worksheet, 2, 2, 0, 14, infoStyle);
  styleFilterGrid(worksheet, 4, filterRows);
  styleRange(worksheet, countRow, countRow, 0, 14, infoStyle);
  styleRange(worksheet, headerRow - 1, headerRow - 1, 0, headers.length - 1, tableHeaderStyle);

  for (let row = firstDataRow; row <= lastDataRow; row += 1) {
    const rowStyle = (row - firstDataRow) % 2 === 0 ? bodyStyle : bodyAltStyle;
    styleRange(worksheet, row - 1, row - 1, 0, headers.length - 1, rowStyle);
    for (const column of ["M", "N", "O"]) {
      const ref = `${column}${row}`;
      setNumberFormat(worksheet, ref, ACCOUNTING_FORMAT);
      if (worksheet[ref]) {
        worksheet[ref].s = {
          ...(worksheet[ref].s ?? {}),
          alignment: { vertical: "center", horizontal: "right" },
          numFmt: ACCOUNTING_FORMAT
        };
      }
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
  styleRange(worksheet, startRow, startRow, startCol, startCol + 3, cardHeaderStyle);

  metrics.forEach(([label, value, kind], index) => {
    const row = startRow + index + 1;
    XLSX.utils.sheet_add_aoa(worksheet, [[label, value]], { origin: { r: row, c: startCol } });
    worksheet["!merges"]!.push({ s: { r: row, c: startCol + 1 }, e: { r: row, c: startCol + 3 } });
    setStyle(worksheet, XLSX.utils.encode_cell({ r: row, c: startCol }), cardLabelStyle);
    styleRange(worksheet, row, row, startCol + 1, startCol + 3, cardValueStyle);
    const valueRef = XLSX.utils.encode_cell({ r: row, c: startCol + 1 });
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
  styleRange(worksheet, startRow, startRow, startCol, startCol + 7, cardHeaderStyle);
  metrics.forEach(([label, value, kind], index) => {
    const row = startRow + index + 1;
    XLSX.utils.sheet_add_aoa(worksheet, [[label, value]], { origin: { r: row, c: startCol } });
    worksheet["!merges"]!.push({ s: { r: row, c: startCol + 1 }, e: { r: row, c: startCol + 7 } });
    setStyle(worksheet, XLSX.utils.encode_cell({ r: row, c: startCol }), cardLabelStyle);
    styleRange(worksheet, row, row, startCol + 1, startCol + 7, cardValueStyle);
    const valueRef = XLSX.utils.encode_cell({ r: row, c: startCol + 1 });
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
  const filterRows = buildFilterRows(filters);
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["ODONTOPIX · RESUMO E ANÁLISE"],
    ["Visão consolidada dos resultados operacionais"],
    [generatedLabel(generatedAt)],
    [],
    ["FILTROS APLICADOS"],
    ["FILTRO", "CRITÉRIO", "FILTRO", "CRITÉRIO", "FILTRO", "CRITÉRIO"],
    ...filterRows
  ]);
  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 15 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 15 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 15 } },
    { s: { r: 4, c: 0 }, e: { r: 4, c: 5 } }
  ];
  worksheet["!cols"] = [
    { wch: 20 }, { wch: 24 }, { wch: 20 }, { wch: 24 }, { wch: 20 }, { wch: 24 },
    { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
    { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 14 }
  ];
  worksheet["!rows"] = [{ hpt: 30 }, { hpt: 22 }, { hpt: 20 }, undefined, { hpt: 22 }, { hpt: 20 }];
  styleRange(worksheet, 0, 0, 0, 15, titleStyle);
  styleRange(worksheet, 1, 1, 0, 15, subtitleStyle);
  styleRange(worksheet, 2, 2, 0, 15, infoStyle);
  styleFilterGrid(worksheet, 4, filterRows);

  const cardRow = Math.max(11, 8 + filterRows.length);
  addSummaryCard(worksheet, 0, cardRow, "CLÍNICO", clinico);
  addSummaryCard(worksheet, 4, cardRow, "ORTO", orto);
  addSummaryCard(worksheet, 8, cardRow, "CLÍNICO + ORTO", combined);
  addSummaryCard(worksheet, 12, cardRow, "ROBÔ · PIX", robo);

  const pixHeaderRow = cardRow + 13;
  XLSX.utils.sheet_add_aoa(worksheet, [["ROBÔ · PIX POR TIPO DE PARCELA"]], { origin: { r: pixHeaderRow, c: 0 } });
  worksheet["!merges"].push({ s: { r: pixHeaderRow, c: 0 }, e: { r: pixHeaderRow, c: 15 } });
  styleRange(worksheet, pixHeaderRow, pixHeaderRow, 0, 15, sectionStyle);
  addPixCard(worksheet, 0, pixHeaderRow + 2, "CLÍNICO · PIX", roboClinico);
  addPixCard(worksheet, 8, pixHeaderRow + 2, "ORTO · PIX", roboOrto);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Resumo e Análise");
  return workbook;
}

export const EXPORT_ACCOUNTING_FORMAT = ACCOUNTING_FORMAT;
