import { describe, expect, it } from "vitest";
import {
  __test__parseRetryAfterMs,
  buildMensalidadesRequestUrl
} from "@/lib/mensalidades-api";

describe("mensalidades-api helpers", () => {
  it("monta a URL com CodigoAssociadoEmpresa e sem CpfUsuario", () => {
    const url = buildMensalidadesRequestUrl(
      "https://erp.exemplo.com",
      "token-123",
      "ASSOC-77"
    );

    expect(url.origin).toBe("https://erp.exemplo.com");
    expect(url.pathname).toBe("/api/Mensalidades");
    expect(url.searchParams.get("CodigoAssociadoEmpresa")).toBe("ASSOC-77");
    expect(url.searchParams.get("HistoricoCompleto")).toBe("true");
    expect(url.searchParams.get("limite")).toBe("200");
    expect(url.searchParams.get("pagina")).toBe("1");
    expect(url.searchParams.get("token")).toBe("token-123");
    expect(url.searchParams.get("CpfUsuario")).toBeNull();
  });

  it("preserva subpath do baseUrl quando existir", () => {
    const url = buildMensalidadesRequestUrl(
      "https://erp.exemplo.com/integracao",
      "token-123",
      "ASSOC-77"
    );

    expect(url.toString()).toBe(
      "https://erp.exemplo.com/integracao/api/Mensalidades?token=token-123&CodigoAssociadoEmpresa=ASSOC-77&HistoricoCompleto=true&limite=200&pagina=1"
    );
  });

  it("monta a pagina solicitada no endpoint", () => {
    const url = buildMensalidadesRequestUrl(
      "https://erp.exemplo.com",
      "token-123",
      "ASSOC-77",
      2
    );

    expect(url.searchParams.get("limite")).toBe("200");
    expect(url.searchParams.get("pagina")).toBe("2");
  });

  it("interpreta Retry-After em segundos", () => {
    expect(__test__parseRetryAfterMs("12")).toBe(12000);
  });

  it("retorna null para Retry-After inválido", () => {
    expect(__test__parseRetryAfterMs("invalido")).toBeNull();
  });
});
