# Ícones do Dashboard Operacional — OdontoartPix

Pacote criado para reproduzir com precisão a identidade visual do dashboard.

## Conteúdo

- `svg/transparent/`: ícones vetoriais escaláveis, fundo transparente.
- `svg/card/`: ícones vetoriais em card escuro com glow discreto.
- `png/transparent/512/`: PNG 512×512 com fundo transparente.
- `png/card/512/`: PNG 512×512 com card escuro.
- `preview.png`: catálogo visual do pacote.
- `icon-map.json`: nomes e cores de cada ícone.

## Padrão visual

- Fundo navy: `#081422`
- Teal principal: `#5EF2DF`
- Teal de ação: `#00E5C3`
- Vermelho de alerta: `#FF6570`
- Branco de controle: `#F5F8FF`
- Traço SVG: `1.7`, pontas e junções arredondadas.

## Uso recomendado no React

Use preferencialmente os arquivos SVG:

```tsx
<img
  src="/icons/01-campanhas-consideradas.svg"
  alt="Campanhas consideradas"
  width={24}
  height={24}
/>
```

Para manter a nitidez, não converta o SVG para base64 e não use screenshots recortados.

## Licença do pacote

Ícones originais criados para este material e liberados para uso no projeto OdontoartPix.
