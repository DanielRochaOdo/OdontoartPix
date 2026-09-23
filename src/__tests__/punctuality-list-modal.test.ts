import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PunctualityListModal } from "@/components/punctuality-list-modal";

describe("Modal de lista completa da Pontualidade", () => {
  it("mantém todas as categorias no modal, mesmo quando o resumo do card exibe apenas oito", () => {
    const rows = Array.from({ length: 14 }, (_, index) => ({
      id: String(index + 1),
      label: "Modalidade " + (index + 1),
      description: "Categoria filtrada " + (index + 1),
      value: String(14 - index) + " dias",
      href: "/pontualidade?detailKey=" + (index + 1) + "#detalhamento"
    }));
    const markup = renderToStaticMarkup(createElement(PunctualityListModal, {
      title: "Formas de pagamento",
      description: "Atraso médio · maior para menor",
      rows
    }));

    expect(markup).toContain("Ver lista completa de Formas de pagamento");
    expect(markup).toContain("14 categorias no filtro atual");
    expect(markup).toContain("Modalidade 1");
    expect(markup).toContain("Modalidade 14");
    expect(markup).toContain("14 dias");
    expect(markup).toContain("1 dias");
    expect(markup.match(/Modalidade [0-9]+<\/p>/g)).toHaveLength(14);
    expect(markup).toContain("overflow-x-hidden");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("max-h-[calc(100dvh-2rem)]");
  });

  it("aceita nomes longos e estados sem resultados sem truncar a lista", () => {
    const markup = renderToStaticMarkup(createElement(PunctualityListModal, {
      title: "Vencimentos",
      description: "Todos os resultados",
      rows: [{ id: "1", label: "Categoria " + "X".repeat(150), value: "1.234 dias", href: "/pontualidade" }]
    }));
    expect(markup).toContain("Categoria " + "X".repeat(150));
    expect(markup).toContain("overflow-wrap:anywhere");
    const empty = renderToStaticMarkup(createElement(PunctualityListModal, {
      title: "Planos", description: "Sem resultados", rows: []
    }));
    expect(empty).toContain("Nenhum registro encontrado");
  });
});
