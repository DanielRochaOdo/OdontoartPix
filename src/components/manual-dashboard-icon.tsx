"use client";

import Image from "next/image";

const ICONS = {
  campaigns: "01-campanhas-consideradas.svg",
  running: "02-campanhas-em-andamento.svg",
  parcels: "03-parcelas-consolidadas.svg",
  paid: "04-pagos.svg",
  unpaid: "05-nao-pagos.svg",
  errors: "06-erros.svg",
  totalValue: "07-valor-total-lotes.svg",
  paidValue: "08-valor-pago.svg",
  utilization: "09-aproveitamento.svg",
  pendingValue: "10-valor-pendente.svg",
  miniChart: "11-aproveitamento-mini-grafico.svg",
  values: "12-valores.svg",
  ticket: "13-ticket-medio.svg",
  insights: "14-insights-rapidos.svg",
  updated: "15-ultima-atualizacao.svg",
  consolidated: "16-dados-consolidados.svg",
  eye: "17-visualizacao.svg",
  active: "18-confirmado-ativo.svg",
  reset: "19-limpar.svg",
  apply: "20-aplicar.svg",
  dropdown: "21-dropdown.svg"
} as const;

export type ManualDashboardIconName = keyof typeof ICONS;

export function ManualDashboardIcon({
  name,
  className = "h-6 w-6",
  alt = ""
}: {
  name: ManualDashboardIconName;
  className?: string;
  alt?: string;
}) {
  return (
    <Image
      src={`/icons/dashboard/${ICONS[name]}`}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      width={24}
      height={24}
      className={className}
    />
  );
}
