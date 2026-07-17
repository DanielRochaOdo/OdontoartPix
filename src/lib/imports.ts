import * as XLSX from "xlsx";
import { isValidCpf, stripCpf } from "@/lib/cpf";

export type ImportRow = {
  cpf: string;
  name?: string;
  external_user_code?: string;
  line: number;
};

export type ImportIssue = {
  line: number;
  cpf?: string;
  reason: string;
};

export async function parseMemberFile(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = file.name.split(".").pop()?.toLowerCase();
  const text = buffer.toString("utf8");
  const rows: Array<Record<string, unknown>> = [];

  if (extension === "xlsx" || extension === "xls") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    if (json.length > 0) {
      rows.push(...json);
    } else {
      const aoa = XLSX.utils.sheet_to_json<Array<string | number | null>>(sheet, { header: 1, defval: "" });
      for (const [index, row] of aoa.entries()) {
        const values = Array.isArray(row) ? row : [];
        rows.push({
          cpf: String(values[0] ?? ""),
          nome: String(values[1] ?? ""),
          codigo_usuario: String(values[2] ?? ""),
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
        rows.push({ cpf: tokens[0], __line: index + 1 });
        continue;
      }
      const cpfCandidate = tokens.find((value) => stripCpf(value).length >= 11) ?? tokens[0] ?? "";
      const nameCandidate = tokens[1] ?? "";
      const codeCandidate = tokens[2] ?? "";
      rows.push({
        cpf: cpfCandidate,
        nome: nameCandidate,
        codigo_usuario: codeCandidate,
        __line: index + 1
      });
    }
  }

  const imports: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const line = Number(row.__line ?? index + 2);
    const rawCpf = String(
      row.cpf ??
      row.CPF ??
      row.Cpf ??
      row.cpf_usuario ??
      row.CpfUsuario ??
      row["cpf_usuario"] ??
      row["CPF"] ??
      ""
    ).trim();
    const cpf = stripCpf(rawCpf);
    const name = String(row.nome ?? row.name ?? row.Nome ?? row.associado ?? "").trim() || undefined;
    const externalUserCode = String(
      row.codigo_usuario ??
      row.codigoUser ??
      row.external_user_code ??
      row.cod_usuario ??
      row.codigo ??
      ""
    ).trim() || undefined;

    if (!cpf) {
      issues.push({ line, reason: "CPF ausente." });
      continue;
    }
    if (cpf.length !== 11 || !isValidCpf(cpf)) {
      issues.push({ line, cpf, reason: "CPF inválido." });
      continue;
    }
    if (seen.has(cpf)) {
      issues.push({ line, cpf, reason: "CPF duplicado no arquivo." });
      continue;
    }
    seen.add(cpf);
    imports.push({ cpf, name, external_user_code: externalUserCode, line });
  }

  return { imports, issues };
}
