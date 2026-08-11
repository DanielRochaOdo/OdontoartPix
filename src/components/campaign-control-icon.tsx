"use client";

import Image from "next/image";

const ICONS = {
  campaigns: "01_campanhas.svg",
  download: "02_baixar_modelo_xlsx.svg",
  importCampaign: "03_importar_campanha_lote.svg",
  destination: "04_destino_importacao.svg",
  campaignName: "05_nome_campanha.svg",
  batchName: "06_nome_lote.svg",
  description: "07_descricao.svg",
  upload: "08_upload_arquivo.svg",
  importBase: "09_importar_base.svg",
  table: "10_tabela_listagem.svg",
  completed: "11_status_concluido.svg",
  users: "12_cpfs_usuarios.svg",
  progress: "13_progresso.svg",
  paid: "14_pagos.svg",
  unpaid: "15_nao_pagos.svg",
  pending: "16_pendencia.svg",
  open: "17_acao_abrir.svg",
  filter: "18_filtro_selecao.svg",
  newCampaign: "19_nova_campanha.svg",
  batch: "20_lote.svg"
} as const;

export type CampaignControlIconName = keyof typeof ICONS;

export function CampaignControlIcon({
  name,
  className = "h-6 w-6",
  alt = ""
}: {
  name: CampaignControlIconName;
  className?: string;
  alt?: string;
}) {
  return (
    <Image
      src={`/icons/campaigns/${ICONS[name]}`}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      width={24}
      height={24}
      className={className}
    />
  );
}
