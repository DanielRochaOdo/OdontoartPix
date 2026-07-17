import { analyzeMonthlyResponse } from "@/lib/analysis";

export async function consultMonthlyByCpf(cpf: string) {
  const baseUrl = process.env.MENSALIDADES_API_BASE_URL;
  const token = process.env.MENSALIDADES_API_TOKEN;
  if (!baseUrl || !token) throw new Error("API externa não configurada.");

  const url = new URL("/api/mensalidade/BuscarDadosMensalidades", baseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("CpfUsuario", cpf);

  const response = await fetch(url.toString(), { method: "GET" });
  const payload = await response.json().catch(() => null);
  return {
    httpStatus: response.status,
    analysis: analyzeMonthlyResponse(payload),
    raw: payload
  };
}
