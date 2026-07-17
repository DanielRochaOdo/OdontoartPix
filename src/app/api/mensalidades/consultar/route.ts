import { z } from "zod";
import { analyzeMonthlyResponse } from "@/lib/analysis";
import { isValidCpf, stripCpf } from "@/lib/cpf";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";

const BodySchema = z.object({
  cpf: z.string().min(11).max(14)
});

async function fetchWithRetry(url: string, init: RequestInit, retries = 3) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);
      if ([400, 401, 403].includes(response.status)) return response;
      if (!response.ok && attempt < retries && [408, 429, 500, 502, 503, 504].includes(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retries) continue;
    }
  }
  throw lastError ?? new Error("Falha na consulta externa.");
}

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Payload inválido.", 400);

  const cpf = stripCpf(parsed.data.cpf);
  if (!isValidCpf(cpf)) return fail("VALIDATION_ERROR", "CPF inválido.", 400);

  const baseUrl = process.env.MENSALIDADES_API_BASE_URL;
  const token = process.env.MENSALIDADES_API_TOKEN;
  if (!baseUrl || !token) return fail("INTERNAL_ERROR", "Serviço não configurado.", 500);

  const url = new URL("/api/mensalidade/BuscarDadosMensalidades", baseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("CpfUsuario", cpf);

  try {
    const response = await fetchWithRetry(url.toString(), { method: "GET" });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    const analysis = analyzeMonthlyResponse(json);
    return ok({ httpStatus: response.status, analysis }, "Consulta realizada.");
  } catch {
    return fail("EXTERNAL_API_ERROR", "Falha ao consultar mensalidades.", 502);
  }
}
