import * as XLSX from "xlsx";
import { toCents } from "@/lib/money";

export type ImportRow = {
  associatedCode: string;
  targetInstallmentId: string;
  installmentAmountCents: number;
  cpf?: string;
  name?: string;
  line: number;
};

export type ImportIssue = {
  line: number;
  associatedCode?: string;
  targetInstallmentId?: string;
  installmentAmountCents?: number | null;
  cpf?: string;
  name?: string;
  reason: string;
};

export type ImportInspectionRow = {
  line: number;
  associatedCode?: string;
  targetInstallmentId?: string;
  installmentAmountCents?: number | null;
  cpf?: string;
  name?: string;
};

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function readColumn(row: Record<string, unknown>, aliases: string[]) {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  const entry = Object.entries(row).find(([key]) => normalizedAliases.has(normalizeHeader(key)));
  return entry?.[1];
}

function normalizeAssociatedCode(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeInstallmentId(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeInstallmentAmount(value: unknown) {
  const parsed = toCents(value);
  if (parsed.warning) {
    return { cents: 0, valid: false };
  }

  return { cents: parsed.cents, valid: true };
}

function normalizeCpf(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return undefined;
  return digits.length < 11 ? digits.padStart(11, "0") : digits;
}

export async function parseMemberFile(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = file.name.split(".").pop()?.toLowerCase();
  const text = buffer.toString("utf8");
  const rows: Array<Record<string, unknown>> = [];

  if (extension === "xlsx" || extension === "xls") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false
    });
    if (json.length > 0) {
      rows.push(...json);
    } else {
      const aoa = XLSX.utils.sheet_to_json<Array<string | number | null>>(sheet, {
        header: 1,
        defval: "",
        raw: false
      });
      for (const [index, row] of aoa.entries()) {
        const values = Array.isArray(row) ? row : [];
        rows.push({
          nome: String(values[0] ?? ""),
          codigo_associado_empresa: String(values[1] ?? ""),
          parcela: String(values[2] ?? ""),
          valor_parcela: String(values[3] ?? ""),
          cpf: String(values[4] ?? ""),
          __line: index + 1
        });
      }
    }
  } else {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\uFEFF/, "").trim())
      .filter(Boolean);
    for (const [index, line] of lines.entries()) {
      const tokens = line.split(/[;,|\t]/).map((value) => value.trim()).filter(Boolean);
      if (tokens.length === 1) {
        rows.push({ codigo_associado_empresa: tokens[0], __line: index + 1 });
        continue;
      }

      rows.push({
        nome: tokens[0] ?? "",
        codigo_associado_empresa: tokens[1] ?? "",
        parcela: tokens[2] ?? "",
        valor_parcela: tokens[3] ?? "",
        cpf: tokens[4] ?? "",
        __line: index + 1
      });
    }
  }

  const imports: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  const inspectedRows: ImportInspectionRow[] = [];
  const seen = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const line = Number(row.__line ?? index + 2);
    const associatedCode = normalizeAssociatedCode(
      readColumn(row, [
        "codigo_associado_empresa",
        "CodigoAssociadoEmpresa",
        "codigo_associado",
        "codigo_usuario",
        "codigo",
        "external_user_code"
      ])
    );
    const targetInstallmentId = normalizeInstallmentId(
      readColumn(row, ["parcela", "id", "installment_id", "target_installment_id"])
    );
    const installmentAmount = normalizeInstallmentAmount(
      readColumn(row, [
        "valor da parcela",
        "valor_parcela",
        "valorparcela",
        "valor",
        "amount"
      ])
    );
    const cpf = normalizeCpf(
      readColumn(row, ["cpf", "cpf_usuario", "CpfUsuario", "cpf/cnpj"])
    );
    const name = String(
      readColumn(row, ["nome", "nome completo", "name", "associado"]) ?? ""
    ).trim() || undefined;

    inspectedRows.push({
      line,
      associatedCode: associatedCode || undefined,
      targetInstallmentId: targetInstallmentId || undefined,
      installmentAmountCents: installmentAmount.valid ? installmentAmount.cents : null,
      cpf,
      name
    });

    if (!associatedCode) {
      issues.push({
        line,
        targetInstallmentId: targetInstallmentId || undefined,
        installmentAmountCents: installmentAmount.valid ? installmentAmount.cents : null,
        cpf,
        name,
        reason: "CodigoAssociadoEmpresa ausente."
      });
      continue;
    }

    if (!targetInstallmentId) {
      issues.push({
        line,
        associatedCode,
        installmentAmountCents: installmentAmount.valid ? installmentAmount.cents : null,
        cpf,
        name,
        reason: "Parcela ausente."
      });
      continue;
    }

    if (!installmentAmount.valid) {
      issues.push({
        line,
        associatedCode,
        targetInstallmentId,
        cpf,
        name,
        reason: "Valor da Parcela ausente ou invalido."
      });
      continue;
    }

    if (seen.has(targetInstallmentId)) {
      issues.push({
        line,
        associatedCode,
        targetInstallmentId,
        installmentAmountCents: installmentAmount.cents,
        cpf,
        name,
        reason: "Parcela duplicada no arquivo."
      });
      continue;
    }

    seen.add(targetInstallmentId);
    imports.push({
      associatedCode,
      targetInstallmentId,
      installmentAmountCents: installmentAmount.cents,
      cpf,
      name,
      line
    });
  }

  return { imports, issues, inspectedRows };
}
