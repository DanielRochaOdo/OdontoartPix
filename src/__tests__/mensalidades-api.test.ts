import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __test__parseRetryAfterMs,
  buildMensalidadesRequestUrl,
  consultMonthlyByAssociatedCode,
  ErpError
} from "@/lib/mensalidades-api";

vi.mock("@/lib/processing-config", () => ({
  getProcessingConfig: vi.fn(async () => ({
    httpConnectTimeoutMs: 1000,
    httpReadTimeoutMs: 1000,
    maxPagesPerOperation: 10
  }))
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MENSALIDADES_API_BASE_URL;
  delete process.env.MENSALIDADES_API_TOKEN;
});

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

  it("para a paginacao assim que encontra a parcela alvo", async () => {
    process.env.MENSALIDADES_API_BASE_URL = "https://erp.exemplo.com";
    process.env.MENSALIDADES_API_TOKEN = "token-123";

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 5,
        TotalCount: 500,
        PageSize: 200,
        Data: [{
          Id: "55",
          Valor: 100,
          ValorPago: 100,
          DescricaoRecebimento: "PIX"
        }]
      },
      erros: null
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await consultMonthlyByAssociatedCode("ASSOC-77", "55");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.analysis.paymentStatus).toBe("paid");
    expect(result.analysis.paginationComplete).toBe(false);
  });

  it("classifica ABERTO como unpaid sem consultar paginas desnecessarias", async () => {
    process.env.MENSALIDADES_API_BASE_URL = "https://erp.exemplo.com";
    process.env.MENSALIDADES_API_TOKEN = "token-123";

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 4,
        TotalCount: 400,
        PageSize: 200,
        Data: [{
          Id: "55",
          Valor: 100,
          DescricaoRecebimento: "ABERTO"
        }]
      },
      erros: null
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await consultMonthlyByAssociatedCode("ASSOC-77", "55");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.analysis.paymentStatus).toBe("unpaid");
  });

  it("percorre ate TotalPages e retorna erro quando a parcela alvo nao aparece", async () => {
    process.env.MENSALIDADES_API_BASE_URL = "https://erp.exemplo.com";
    process.env.MENSALIDADES_API_TOKEN = "token-123";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        codigo: 1,
        dados: {
          CurrentPage: 1,
          TotalPages: 3,
          TotalCount: 3,
          PageSize: 1,
          Data: [{ Id: "10", Valor: 50, DescricaoRecebimento: "ABERTO" }]
        },
        erros: null
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        codigo: 1,
        dados: {
          CurrentPage: 2,
          TotalPages: 3,
          TotalCount: 3,
          PageSize: 1,
          Data: [{ Id: "11", Valor: 60, ValorPago: 60, DescricaoRecebimento: "PIX" }]
        },
        erros: null
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        codigo: 1,
        dados: {
          CurrentPage: 3,
          TotalPages: 3,
          TotalCount: 3,
          PageSize: 1,
          Data: [{ Id: "12", Valor: 70, DescricaoRecebimento: "ABERTO" }]
        },
        erros: null
      }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await consultMonthlyByAssociatedCode("ASSOC-77", "55");
    } catch (error) {
      caught = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(caught).toBeInstanceOf(ErpError);
    expect(caught).toMatchObject({
      code: "ERP_INVALID_RESPONSE",
      retryable: false
    });
    expect((caught as Error).message).toContain("parcela alvo 55 nao foi localizada");
  });

  it("rejeita pagamento parcial quando ValorPago e inferior ao Valor", async () => {
    process.env.MENSALIDADES_API_BASE_URL = "https://erp.exemplo.com";
    process.env.MENSALIDADES_API_TOKEN = "token-123";

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      codigo: 1,
      dados: {
        CurrentPage: 1,
        TotalPages: 1,
        TotalCount: 1,
        PageSize: 100,
        Data: [{
          Id: "55",
          Valor: 100,
          ValorPago: 90,
          DescricaoRecebimento: "PIX"
        }]
      },
      erros: null
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await consultMonthlyByAssociatedCode("ASSOC-77", "55");
    } catch (error) {
      caught = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(ErpError);
    expect(caught).toMatchObject({
      code: "ERP_INVALID_RESPONSE",
      retryable: false,
      httpStatus: 200
    });
    expect((caught as Error).message).toContain("ValorPago inferior ao Valor");
  });

  it("interpreta Retry-After em segundos", () => {
    expect(__test__parseRetryAfterMs("12")).toBe(12000);
  });

  it("retorna null para Retry-After invalido", () => {
    expect(__test__parseRetryAfterMs("invalido")).toBeNull();
  });
});
