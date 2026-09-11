import * as XLSX from "xlsx-js-style";

export type DispatchesExportFilter = {
  label: string;
  value: string;
};

export type DispatchesExportRow = {
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
  dispatchCount: number;
  lastDispatchDate: string;
};

const ACCOUNTING_FORMAT = '"R$" #,##0.00;[Red]-"R$" #,##0.00;"R$" -';
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

function buildFilterRows(filters: DispatchesExportFilter[]) {
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

export function buildDispatchesWorkbook({
  rows,
  filters,
  generatedAt = new Date()
}: {
  rows: DispatchesExportRow[];
  filters: DispatchesExportFilter[];
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
    "Pendência (R$)",
    "Qtde disparos",
    "Último disparo"
  ];
  const filterRows = buildFilterRows(filters);
  const metadataRows: (string | number | null)[][] = [
    ["ODONTOPIX · DISPAROS"],
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
      row.pendingCents / 100,
      row.dispatchCount,
      row.lastDispatchDate
    ]),
    { origin: `A${firstDataRow}` }
  );

  const countRow = 7 + filterRows.length;
  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 16 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 16 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 16 } },
    { s: { r: 4, c: 0 }, e: { r: 4, c: 5 } },
    { s: { r: countRow, c: 0 }, e: { r: countRow, c: 16 } }
  ];
  worksheet["!autofilter"] = { ref: `A${headerRow}:Q${Math.max(headerRow, lastDataRow)}` };
  worksheet["!cols"] = [
    { wch: 32 }, { wch: 24 }, { wch: 20 }, { wch: 24 }, { wch: 20 }, { wch: 28 },
    { wch: 26 }, { wch: 22 }, { wch: 22 }, { wch: 30 }, { wch: 18 }, { wch: 20 },
    { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 20 }
  ];
  worksheet["!rows"] = [{ hpt: 30 }, { hpt: 22 }, { hpt: 20 }, {}, { hpt: 22 }, { hpt: 20 }];

  styleRange(worksheet, 0, 0, 0, 16, titleStyle);
  styleRange(worksheet, 1, 1, 0, 16, subtitleStyle);
  styleRange(worksheet, 2, 2, 0, 16, infoStyle);
  styleFilterGrid(worksheet, 4, filterRows);
  styleRange(worksheet, countRow, countRow, 0, 16, infoStyle);
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
    for (const column of ["P"]) {
      const ref = `${column}${row}`;
      if (worksheet[ref]) {
        worksheet[ref].s = {
          ...(worksheet[ref].s ?? {}),
          alignment: { vertical: "center", horizontal: "center" }
        };
      }
    }
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Disparos");
  return workbook;
}
