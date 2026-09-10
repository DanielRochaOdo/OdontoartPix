import type { SummaryPixExportEntity, SummaryExportEntity, ExportFilter } from "@/lib/export-workbooks";

type PdfColor = [number, number, number];
type PdfPage = string[];

export type SummaryAnalysisPdfData = {
  filters: ExportFilter[];
  dispatchUnitCostCents: number;
  clinico: SummaryExportEntity;
  orto: SummaryExportEntity;
  combined: SummaryExportEntity;
  robo: SummaryExportEntity;
  roboClinico: SummaryPixExportEntity;
  roboOrto: SummaryPixExportEntity;
  generatedAt?: Date;
};

const COLORS = {
  page: [0.025, 0.09, 0.12] as PdfColor,
  panel: [0.035, 0.14, 0.18] as PdfColor,
  panel2: [0.045, 0.18, 0.22] as PdfColor,
  border: [0.08, 0.45, 0.43] as PdfColor,
  brand: [0.05, 0.78, 0.69] as PdfColor,
  text: [0.93, 0.98, 0.98] as PdfColor,
  muted: [0.61, 0.75, 0.76] as PdfColor,
  success: [0.23, 0.82, 0.56] as PdfColor
};

function ascii(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "?");
}

function escapePdf(value: string) {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function currency(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function count(value: number) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function percentage(value: number) {
  return `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;
}

function color([r, g, b]: PdfColor) {
  return `${r} ${g} ${b}`;
}

function rect(page: PdfPage, x: number, y: number, width: number, height: number, fill: PdfColor, stroke?: PdfColor) {
  page.push(`${color(fill)} rg`);
  if (stroke) page.push(`${color(stroke)} RG 0.8 w`);
  page.push(`${x} ${y} ${width} ${height} re ${stroke ? "B" : "f"}`);
}

function text(page: PdfPage, value: string, x: number, y: number, size = 10, fill: PdfColor = COLORS.text, bold = false) {
  page.push("BT");
  page.push(`${color(fill)} rg`);
  page.push(`/${bold ? "F2" : "F1"} ${size} Tf`);
  page.push(`1 0 0 1 ${x} ${y} Tm`);
  page.push(`(${escapePdf(value)}) Tj`);
  page.push("ET");
}

function truncate(value: string, max = 76) {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function pageHeader(page: PdfPage, subtitle: string) {
  rect(page, 0, 0, 595, 842, COLORS.page);
  rect(page, 32, 777, 531, 42, COLORS.panel2, COLORS.border);
  text(page, "ODONTOPIX", 48, 798, 10, COLORS.brand, true);
  text(page, "Resumo e Analise", 48, 782, 17, COLORS.text, true);
  text(page, subtitle, 390, 790, 8, COLORS.muted);
}

function metricCard(page: PdfPage, x: number, y: number, width: number, title: string, entity: SummaryExportEntity) {
  const height = 190;
  rect(page, x, y, width, height, COLORS.panel, COLORS.border);
  rect(page, x, y + height - 34, width, 34, COLORS.panel2);
  text(page, title, x + 14, y + height - 22, 12, COLORS.brand, true);

  const metrics = [
    ["Qtde disparos", count(entity.dispatchCount)],
    ["Valor disparos", currency(entity.dispatchValueCents)],
    ["Custo acao", currency(entity.actionCostCents)],
    ["Assoc. pagos", count(entity.paidAssociateCount)],
    ["% assoc. pagos", percentage(entity.paidAssociatePercentage)],
    ["Parcelas pagas", count(entity.paidInstallmentCount)],
    ["% parcelas pagas", percentage(entity.paidInstallmentPercentage)],
    ["Pago", currency(entity.paidAmountCents)],
    ["% pago", percentage(entity.paidPercentage)],
    ["Liquido", currency(entity.netAmountCents)]
  ];
  metrics.forEach(([label, value], index) => {
    const column = index < 5 ? 0 : 1;
    const row = index % 5;
    const metricX = x + 14 + column * (width / 2);
    const metricY = y + height - 58 - row * 27;
    text(page, label, metricX, metricY, 7.2, COLORS.muted);
    text(page, value, metricX, metricY - 12, 9, label === "Liquido" ? COLORS.success : COLORS.text, true);
  });
}

function pixCard(page: PdfPage, x: number, y: number, width: number, title: string, entity: SummaryPixExportEntity) {
  const height = 124;
  rect(page, x, y, width, height, COLORS.panel, COLORS.border);
  rect(page, x, y + height - 34, width, 34, COLORS.panel2);
  text(page, title, x + 14, y + height - 22, 12, COLORS.brand, true);
  const metrics = [
    ["Valor das parcelas", currency(entity.dispatchValueCents)],
    ["Associados pagos", count(entity.paidAssociateCount)],
    ["Parcelas pagas", count(entity.paidInstallmentCount)],
    ["Recebido via PIX", currency(entity.paidAmountCents)]
  ];
  metrics.forEach(([label, value], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const metricX = x + 14 + column * (width / 2);
    const metricY = y + 65 - row * 38;
    text(page, label, metricX, metricY, 7.5, COLORS.muted);
    text(page, value, metricX, metricY - 13, 9.5, index === 3 ? COLORS.success : COLORS.text, true);
  });
}

export function buildSummaryAnalysisPdf(data: SummaryAnalysisPdfData) {
  const page1: PdfPage = [];
  const page2: PdfPage = [];
  const pages = [page1, page2];

  pageHeader(page1, "Relatorio operacional");
  text(page1, "FILTROS APLICADOS", 36, 750, 9, COLORS.brand, true);
  const filterHeight = Math.max(72, Math.ceil(data.filters.length / 2) * 34 + 18);
  const filterY = 742 - filterHeight;
  rect(page1, 32, filterY, 531, filterHeight, COLORS.panel, COLORS.border);
  data.filters.forEach((filter, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 48 + column * 260;
    const y = 718 - row * 34;
    text(page1, filter.label, x, y, 7.2, COLORS.muted);
    text(page1, truncate(filter.value, 54), x, y - 13, 8.8, COLORS.text, true);
  });

  const resultsTitleY = filterY - 24;
  text(page1, "RESULTADOS", 36, resultsTitleY, 9, COLORS.brand, true);
  const firstCardsY = resultsTitleY - 204;
  metricCard(page1, 32, firstCardsY, 255, "CLINICO", data.clinico);
  metricCard(page1, 308, firstCardsY, 255, "ORTO", data.orto);
  const secondCardsY = firstCardsY - 207;
  metricCard(page1, 32, secondCardsY, 255, "CLINICO + ORTO", data.combined);
  metricCard(page1, 308, secondCardsY, 255, "ROBO · PIX", data.robo);
  text(page1, `Custo unitario por disparo: ${currency(data.dispatchUnitCostCents)}`, 36, Math.max(28, secondCardsY - 24), 8, COLORS.muted);

  pageHeader(page2, "Detalhamento do Robo");
  text(page2, "ROBO · PIX POR TIPO DE PARCELA", 36, 748, 10, COLORS.brand, true);
  text(page2, "Mesma leitura visual dos cards do sistema, separada entre Clinico e Orto.", 36, 731, 8.5, COLORS.muted);
  pixCard(page2, 32, 580, 255, "CLINICO · PIX", data.roboClinico);
  pixCard(page2, 308, 580, 255, "ORTO · PIX", data.roboOrto);

  rect(page2, 32, 448, 531, 104, COLORS.panel, COLORS.border);
  text(page2, "FILTROS DO ARQUIVO", 48, 526, 9, COLORS.brand, true);
  data.filters.slice(0, 4).forEach((filter, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 48 + column * 260;
    const y = 504 - row * 34;
    text(page2, filter.label, x, y, 7.2, COLORS.muted);
    text(page2, truncate(filter.value, 54), x, y - 13, 8.8, COLORS.text, true);
  });

  rect(page2, 32, 330, 531, 92, COLORS.panel, COLORS.border);
  text(page2, "LEITURA DO RELATORIO", 48, 396, 9, COLORS.brand, true);
  text(page2, "Os valores e contagens refletem exatamente os filtros exibidos neste arquivo.", 48, 374, 8.5, COLORS.text);
  text(page2, "Quando vencimento e pagamento sao informados juntos, os criterios sao cumulativos.", 48, 357, 8.5, COLORS.text);
  text(page2, `Gerado em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(data.generatedAt ?? new Date())}`, 48, 340, 8, COLORS.muted);

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 8 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"
  ];
  pages.forEach((page) => {
    const stream = page.join("\n") + "\n";
    objects.push(`<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`);
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf, "ascii");
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}
