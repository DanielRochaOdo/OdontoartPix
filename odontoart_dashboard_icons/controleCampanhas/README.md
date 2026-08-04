# Pacote de ícones — Gestão de Campanhas | Odontoart Pix

Conteúdo:
- `svg/solid`: vetores em gradiente teal, fundo transparente.
- `svg/outline`: variação contornada, fundo transparente.
- `svg/card`: ícones em cards escuros prontos para referência visual.
- `png/512` e `png/256`: exportações raster nas três variações.
- `preview_catalogo.png`: catálogo de todos os ícones.
- `manual_visual.png`: manual visual criado para esta página.
- `manifest.json`: nomes, classes e finalidades.

Paleta:
- Teal principal: `#00F0C2`
- Teal claro: `#73FFE8`
- Fundo navy: `#071525`
- Fundo secundário: `#0B2133`
- Borda teal: `#16C79A`

Uso em React/Next.js:
```tsx
import Image from "next/image";

<Image
  src="/icons/gestao-campanhas/svg/solid/08_upload_arquivo.svg"
  alt="Upload de arquivo"
  width={24}
  height={24}
/>
```

Para ícones pequenos de interface, use 20–24 px. Em cards de cabeçalho, use 40–56 px.
