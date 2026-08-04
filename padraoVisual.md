Realize uma padronização visual focada exclusivamente em:

1. cores utilizadas nos temas claro e escuro;
2. consistência das cores entre todos os módulos;
3. padronização dos cabeçalhos das páginas;
4. contraste, legibilidade e experiência do usuário na troca de tema.

Não realizar redesign estrutural das páginas.

Não alterar:

- ícones existentes;
- SVGs;
- posição dos ícones;
- gráficos;
- disposição dos cards;
- grids;
- dimensões dos componentes;
- regras de negócio;
- processamento;
- filtros;
- tabelas;
- rotas;
- APIs;
- banco de dados;
- conteúdo textual funcional;
- fluxos de navegação;
- funcionalidades dos botões.

A tarefa deve atuar somente sobre cores, superfícies, bordas, textos, estados visuais e cabeçalhos.

==================================================
1. PROBLEMA ATUAL IDENTIFICADO
==================================================

O sistema possui estilos inconsistentes entre módulos.

Atualmente:

- Dashboard utiliza cores hexadecimais próprias:
  - `#f5f8fc`;
  - `#020d1f`;
  - `#071b34`;
  - `#284665`;
  - `#00E5C3`;
  - `#FF5B5B`;
  - outras variações próximas.

- Campanhas utiliza uma paleta parecida, mas não exatamente igual:
  - `#00a98f`;
  - `#00F0C2`;
  - `#dffaf4`;
  - `#071b34`;
  - `#0B2133`;
  - `#284665`.

- Associados, detalhes de associado, Configurações, Eventos e Lotes ainda utilizam principalmente:
  - `bg-white`;
  - `bg-slate-50`;
  - `text-slate-500`;
  - `text-slate-600`;
  - `text-slate-900`;
  - `border-slate-200`;
  - `text-emerald-700`.

Essas páginas não possuem correspondência completa no tema escuro.

Isso provoca:

- fundos brancos excessivos no tema claro;
- contraste muito agressivo entre cards e fundo;
- páginas parcialmente claras dentro do tema escuro;
- textos escuros sobre fundos escuros;
- textos claros demais em determinadas superfícies;
- cabeçalhos diferentes entre módulos;
- bordas com forças diferentes;
- elementos que parecem pertencer a aplicações distintas;
- cores de sucesso, erro e destaque diferentes para a mesma função.

==================================================
2. ESCOPO EXATO DA ALTERAÇÃO
==================================================

Aplicar a padronização nos seguintes módulos:

- Dashboard;
- Campanhas;
- detalhe de campanha;
- Lotes;
- detalhe de lote;
- Associados;
- detalhe de associado;
- Eventos;
- Configurações.

Também revisar os componentes visuais usados por essas páginas, especialmente:

- DashboardFilters;
- DashboardMetricCard;
- DashboardDonutCharts;
- CampaignImportForm;
- CampaignBatchProgressStack;
- MembersTable;
- ProcessingProgressPanel;
- ProcessingSettingsForm;
- tabelas compartilhadas;
- modais;
- badges;
- mensagens de erro;
- estados vazios.

Não alterar o layout desses componentes.

Alterar apenas as cores para que eles utilizem tokens semânticos compartilhados.

==================================================
3. PRINCÍPIO CENTRAL
==================================================

Nenhum módulo deve escolher sua própria cor para uma função visual compartilhada.

A mesma função deve usar o mesmo token em todo o sistema.

Exemplos:

- fundo geral:
  `bg-app`;

- superfície principal:
  `bg-surface-primary`;

- superfície interna:
  `bg-surface-secondary`;

- texto principal:
  `text-primary`;

- texto auxiliar:
  `text-secondary`;

- texto discreto:
  `text-muted`;

- borda padrão:
  `border-default`;

- divisor:
  `border-subtle`;

- ação principal:
  `brand-primary`;

- sucesso:
  `status-success`;

- erro:
  `status-danger`;

- alerta:
  `status-warning`;

- informação ou processamento:
  `status-info`.

Os componentes não devem saber se o tema atual é claro ou escuro.

Eles devem apenas utilizar tokens semânticos.

==================================================
4. CRIAR TOKENS DE TEMA
==================================================

Criar CSS Variables globais.

Exemplo:

:root,
[data-theme="light"] {
  --color-app-background: ...;
  --color-app-background-subtle: ...;

  --color-surface-primary: ...;
  --color-surface-secondary: ...;
  --color-surface-tertiary: ...;
  --color-surface-elevated: ...;
  --color-surface-hover: ...;
  --color-surface-selected: ...;

  --color-text-primary: ...;
  --color-text-secondary: ...;
  --color-text-muted: ...;
  --color-text-disabled: ...;
  --color-text-inverse: ...;

  --color-border-subtle: ...;
  --color-border-default: ...;
  --color-border-strong: ...;
  --color-border-focus: ...;

  --color-brand-primary: ...;
  --color-brand-hover: ...;
  --color-brand-active: ...;
  --color-brand-soft: ...;

  --color-success: ...;
  --color-success-soft: ...;

  --color-warning: ...;
  --color-warning-soft: ...;

  --color-danger: ...;
  --color-danger-soft: ...;

  --color-info: ...;
  --color-info-soft: ...;

  --color-chart-paid: ...;
  --color-chart-unpaid: ...;
  --color-chart-paid-value: ...;
  --color-chart-pending-value: ...;

  --color-focus-ring: ...;
}

[data-theme="dark"] {
  mesmos tokens com valores próprios do tema escuro;
}

==================================================
5. PALETA OFICIAL — TEMA CLARO
==================================================

Utilizar esta base:

Fundo geral da aplicação:

--color-app-background: #F4F7FB;

Fundo sutil:

--color-app-background-subtle: #EEF3F8;

Superfície principal:

--color-surface-primary: #FFFFFF;

Superfície secundária:

--color-surface-secondary: #F8FAFC;

Superfície terciária:

--color-surface-tertiary: #F1F5F9;

Superfície elevada:

--color-surface-elevated: #FFFFFF;

Hover:

--color-surface-hover: #EFF7F6;

Selecionado:

--color-surface-selected: #E5F8F4;

Texto principal:

--color-text-primary: #102033;

Texto secundário:

--color-text-secondary: #52677C;

Texto discreto:

--color-text-muted: #75879A;

Texto desabilitado:

--color-text-disabled: #9EABB9;

Texto inverso:

--color-text-inverse: #FFFFFF;

Borda sutil:

--color-border-subtle: #E4EBF2;

Borda padrão:

--color-border-default: #D2DFEA;

Borda forte:

--color-border-strong: #B6C8D8;

Borda de foco:

--color-border-focus: #009B84;

Marca principal:

--color-brand-primary: #009B84;

Hover da marca:

--color-brand-hover: #007F6D;

Estado ativo:

--color-brand-active: #006B5C;

Marca suave:

--color-brand-soft: rgba(0, 155, 132, 0.10);

==================================================
6. PALETA OFICIAL — TEMA ESCURO
==================================================

Utilizar esta base:

Fundo geral da aplicação:

--color-app-background: #020D1F;

Fundo sutil:

--color-app-background-subtle: #051426;

Superfície principal:

--color-surface-primary: #071B34;

Superfície secundária:

--color-surface-secondary: #0B2133;

Superfície terciária:

--color-surface-tertiary: #10263E;

Superfície elevada:

--color-surface-elevated: #112B46;

Hover:

--color-surface-hover: #0B2944;

Selecionado:

--color-surface-selected: rgba(0, 229, 195, 0.12);

Texto principal:

--color-text-primary: #F5F8FF;

Texto secundário:

--color-text-secondary: #B7C9DC;

Texto discreto:

--color-text-muted: #8CA3B3;

Texto desabilitado:

--color-text-disabled: #60778C;

Texto inverso:

--color-text-inverse: #03121F;

Borda sutil:

--color-border-subtle: #183956;

Borda padrão:

--color-border-default: #284665;

Borda forte:

--color-border-strong: #3A5E7E;

Borda de foco:

--color-border-focus: #00E5C3;

Marca principal:

--color-brand-primary: #00E5C3;

Hover da marca:

--color-brand-hover: #16F0CF;

Estado ativo:

--color-brand-active: #00C3A6;

Marca suave:

--color-brand-soft: rgba(0, 229, 195, 0.12);

==================================================
7. CORES SEMÂNTICAS
==================================================

Padronizar o significado das cores nos dois temas.

SUCESSO

Utilizar em:

- pago;
- concluído;
- processamento concluído;
- importação concluída;
- confirmação;
- filtro aplicado.

Tema claro:

--color-success: #078A57;
--color-success-soft: rgba(7, 138, 87, 0.10);

Tema escuro:

--color-success: #22D58C;
--color-success-soft: rgba(34, 213, 140, 0.12);

ERRO

Utilizar em:

- erro;
- falha;
- bloqueado;
- valor pendente quando tratado como situação crítica;
- exclusão;
- interrupção destrutiva.

Tema claro:

--color-danger: #D94352;
--color-danger-soft: rgba(217, 67, 82, 0.10);

Tema escuro:

--color-danger: #FF5B68;
--color-danger-soft: rgba(255, 91, 104, 0.12);

ALERTA

Utilizar em:

- retry;
- aguardando;
- pendência operacional;
- importação ignorada;
- processamento parcial.

Tema claro:

--color-warning: #A96700;
--color-warning-soft: rgba(169, 103, 0, 0.10);

Tema escuro:

--color-warning: #F7B731;
--color-warning-soft: rgba(247, 183, 49, 0.12);

INFORMAÇÃO

Utilizar em:

- processando;
- ações informativas;
- status de execução;
- links auxiliares;
- informações neutras em destaque.

Tema claro:

--color-info: #087FAF;
--color-info-soft: rgba(8, 127, 175, 0.10);

Tema escuro:

--color-info: #32B8F4;
--color-info-soft: rgba(50, 184, 244, 0.12);

==================================================
8. COR DOS GRÁFICOS
==================================================

Os gráficos devem manter o mesmo significado em ambos os temas.

Pagos:

Tema claro:
#18A873

Tema escuro:
#22D58C

Não pagos:

Tema claro:
#E05259

Tema escuro:
#FF5B5B

Valor pago:

Tema claro:
#088FC7

Tema escuro:
#10B7F4

Valor pendente:

Tema claro:
#D94352

Tema escuro:
#FF5B68

As cores não devem mudar de significado ao trocar o tema.

Não alterar:

- formato dos gráficos;
- dimensões;
- legendas;
- valores;
- lógica;
- posição.

Alterar apenas:

- cores;
- fundo;
- cor dos textos;
- cor do tooltip;
- cor das bordas;
- cor das linhas auxiliares.

==================================================
9. REGRA DE CONTRASTE NO TEMA CLARO
==================================================

O tema claro atual possui excesso de branco puro e cyan claro.

Corrigir para que:

- o fundo geral seja cinza-azulado muito claro;
- os cards continuem brancos;
- os cards sejam separados por borda e sombra discreta;
- textos principais utilizem azul-marinho escuro;
- textos auxiliares utilizem cinza-azulado;
- cyan e teal não sejam usados em todos os textos;
- verde seja utilizado somente quando houver significado;
- vermelho seja utilizado somente em erro ou pendência;
- ícones não pareçam fluorescentes.

Não usar:

- texto cyan muito claro sobre fundo branco;
- borda cyan intensa em todos os cards;
- fundo branco em todos os níveis da hierarquia;
- texto cinza muito claro sobre branco.

==================================================
10. REGRA DE CONTRASTE NO TEMA ESCURO
==================================================

O tema escuro atual utiliza muitas superfícies azul-marinho próximas.

Corrigir para que:

- o fundo geral seja o nível mais escuro;
- cards principais usem surface-primary;
- cards internos usem surface-secondary;
- superfícies elevadas usem surface-elevated;
- bordas sejam visíveis sem parecer luminosas;
- texto principal seja claro;
- texto secundário seja azul-cinza;
- texto muted continue legível;
- glow seja utilizado somente em foco, seleção ou ação principal.

Não usar:

- branco puro em todos os textos;
- teal em todos os valores;
- borda neon em todos os cards;
- fundos quase pretos misturados com cards slate genéricos;
- `bg-white` dentro do tema escuro;
- `text-slate-900` dentro do tema escuro;
- `text-emerald-700` sem variante para tema escuro.

==================================================
11. PADRONIZAR O FUNDO DAS PÁGINAS
==================================================

Todas as páginas protegidas devem utilizar o mesmo fundo.

Criar um componente ou classe compartilhada:

PageSurface

Padrão:

className="
  min-h-screen
  bg-app
  text-primary
"

Aplicar em:

- Dashboard;
- Campanhas;
- Associados;
- Eventos;
- Configurações;
- Lotes;
- páginas de detalhe.

Não permitir que apenas Dashboard e Campanhas definam o fundo manualmente enquanto as outras páginas herdam valores indefinidos.

Remover das páginas:

- `bg-[#f5f8fc]`;
- `dark:bg-[#020d1f]`;
- `bg-white` como fundo geral;
- `bg-slate-950` como fundo geral de módulo;
- combinações independentes de cada rota.

Esses valores devem existir somente na definição dos tokens.

==================================================
12. PADRONIZAÇÃO DOS CABEÇALHOS
==================================================

Criar um componente compartilhado:

PageHeader

Esse componente deve ser usado por todos os módulos.

Estrutura padrão para páginas principais:

<div className="page-header">
  <div className="page-header__identity">
    <span className="page-header__accent" />
    <div>
      <h1 className="page-header__title">...</h1>
      <p className="page-header__description">...</p>
    </div>
  </div>

  <div className="page-header__actions">
    ...
  </div>
</div>

Características visuais:

- barra vertical de destaque com brand-primary;
- título com text-primary;
- descrição com text-secondary;
- ações alinhadas à direita;
- divisor inferior com border-subtle;
- mesmo espaçamento;
- mesma altura visual;
- mesmo tamanho de título;
- mesma largura da barra;
- mesmas cores nos dois temas.

Padrão do título:

- desktop: text-3xl ou lg:text-4xl;
- font-semibold;
- tracking-tight;
- text-primary.

Descrição:

- text-sm;
- text-secondary;
- máximo de largura somente quando necessário.

Barra:

- largura de 4px;
- altura aproximada entre 36px e 44px;
- rounded-full;
- brand-primary;
- glow muito discreto apenas no tema escuro.

Divisor:

- border-b;
- border-subtle;
- padding inferior consistente.

==================================================
13. CABEÇALHOS DAS PÁGINAS PRINCIPAIS
==================================================

Aplicar o mesmo padrão em:

Dashboard:

Título:
Dashboard operacional

Descrição:
Indicadores consolidados de campanhas, processamento e pendências financeiras.

Campanhas:

Título:
Gestão de campanhas

Descrição:
Importação separada do processamento, com totais calculados diretamente no banco.

Associados:

Título:
Associados

Descrição:
Consulte CódigoAssociadoEmpresa, parcela, CPF, campanha, lote, status e pendências.

Eventos:

Título:
Eventos

Descrição:
Histórico de processamentos, conclusões e ocorrências operacionais.

Configurações:

Título:
Configurações

Descrição:
Ajuste os perfis padrão do pipeline de processamento sem editar arquivos do ambiente.

Lotes:

Título:
Lotes

Descrição:
Gestão de importação, processamento e retomada de lotes.

Todos devem utilizar:

- mesmo PageHeader;
- mesmas cores;
- mesmo divisor;
- mesmo padding inferior;
- mesma posição das ações;
- mesma hierarquia textual.

==================================================
14. CABEÇALHOS DAS PÁGINAS DE DETALHE
==================================================

Criar uma variante do mesmo PageHeader:

PageHeader variant="detail"

Utilizar em:

- detalhe de campanha;
- detalhe de lote;
- detalhe de associado.

Estrutura:

Breadcrumb
Eyebrow
Título
Descrição opcional
Ações

Breadcrumb:

- text-muted;
- links em text-secondary;
- hover em brand-primary;
- item atual em text-primary.

Eyebrow:

- text-xs ou text-sm;
- uppercase;
- tracking-[0.18em];
- brand-primary.

Título:

- text-3xl;
- text-primary;
- font-semibold.

Descrição:

- text-secondary.

Ações:

- alinhadas à direita;
- preservar os botões e suas funcionalidades existentes.

Não criar um cabeçalho visual completamente diferente para páginas de detalhe.

A variante deve manter:

- mesma paleta;
- mesma largura;
- mesmo divisor;
- mesma tipografia;
- mesmos espaçamentos.

==================================================
15. MIGRAÇÃO DAS CORES HARDCODED
==================================================

Substituir as cores escritas diretamente nos componentes.

Exemplos atuais:

- `bg-[#f5f8fc]`;
- `dark:bg-[#020d1f]`;
- `bg-[#071b34]`;
- `dark:bg-[#071b34]/90`;
- `border-[#284665]`;
- `text-[#102033]`;
- `dark:text-[#F5F8FF]`;
- `text-[#5d7184]`;
- `dark:text-[#8CA3B3]`;
- `text-[#00F0C2]`;
- `bg-[#0B2133]`;
- `border-slate-200`;
- `bg-white`;
- `bg-slate-50`;
- `text-slate-500`;
- `text-slate-600`;
- `text-slate-900`;
- `text-emerald-700`.

Substituir por classes semânticas:

- `bg-app`;
- `bg-surface-primary`;
- `bg-surface-secondary`;
- `bg-surface-tertiary`;
- `bg-surface-hover`;
- `text-primary`;
- `text-secondary`;
- `text-muted`;
- `border-subtle`;
- `border-default`;
- `border-strong`;
- `text-brand`;
- `bg-brand-soft`;
- `text-success`;
- `bg-success-soft`;
- `text-danger`;
- `bg-danger-soft`;
- `text-warning`;
- `bg-warning-soft`;
- `text-info`;
- `bg-info-soft`.

Não deixar as classes antigas espalhadas pelos módulos.

==================================================
16. TABELAS
==================================================

Sem alterar estrutura ou dimensões, padronizar somente as cores.

Container:

- bg-surface-primary;
- border-default.

Cabeçalho:

- bg-surface-secondary;
- text-secondary.

Linha:

- bg-surface-primary;
- border-subtle;
- text-primary.

Texto auxiliar:

- text-muted.

Hover:

- bg-surface-hover.

Linha selecionada:

- bg-surface-selected.

Links:

- text-brand;
- hover com brand-hover.

Tema claro e escuro devem ter o mesmo nível de hierarquia visual.

Corrigir especialmente a tabela de Campanhas, pois atualmente o hover usa:

`hover:bg-[#0B2133]/70`

sem variante clara adequada.

==================================================
17. CARDS E PAINÉIS
==================================================

Sem mudar tamanhos ou layout:

Card principal:

- bg-surface-primary;
- border-default;
- text-primary.

Card interno:

- bg-surface-secondary;
- border-subtle.

Card elevado:

- bg-surface-elevated;
- border-default.

Hover:

- bg-surface-hover;
- border-strong ou brand com baixa opacidade.

Labels:

- text-secondary.

Valores:

- text-primary.

Valores semânticos:

- sucesso: text-success;
- erro: text-danger;
- aviso: text-warning;
- informação: text-info.

Não transformar todos os valores em teal.

==================================================
18. CAMPOS, FILTROS E DROPDOWNS
==================================================

Sem alterar dimensões ou comportamento.

Tema claro:

- fundo: surface-primary;
- borda: border-default;
- texto: text-primary;
- placeholder: text-muted.

Tema escuro:

- fundo: surface-secondary;
- borda: border-default;
- texto: text-primary;
- placeholder: text-muted.

Hover:

- border-strong.

Focus:

- border-focus;
- focus ring de brand-primary.

Dropdown aberto:

- surface-elevated;
- border-default;
- shadow adequado ao tema.

Não deixar campos brancos demais no tema claro nem quase pretos no tema escuro.

==================================================
19. BOTÕES
==================================================

Não alterar ícones, textos, tamanhos ou ações.

Somente padronizar as cores.

Primary:

Tema claro:
- brand-primary;
- text-inverse.

Tema escuro:
- brand-primary;
- text-inverse escuro quando houver contraste suficiente.

Secondary:

- surface-secondary;
- border-default;
- text-primary.

Ghost:

- fundo transparente;
- text-secondary;
- hover surface-hover.

Danger:

- danger;
- danger-soft;
- contraste correto em ambos os temas.

Botões somente com ícones devem manter o SVG atual.

==================================================
20. MENSAGENS DE ERRO E ALERTA
==================================================

Substituir combinações fixas como:

- `border-red-200 bg-red-50 text-red-700`;
- `border-amber-200 bg-amber-50 text-amber-950`.

Por tokens semânticos.

Erro:

- border-danger;
- bg-danger-soft;
- text-danger.

Alerta:

- border-warning;
- bg-warning-soft;
- text-warning.

Isso deve funcionar tanto no claro quanto no escuro.

==================================================
21. SIDEBAR E CONTEÚDO
==================================================

Não redesenhar a sidebar.

Não alterar os ícones.

Apenas garantir que:

- o fundo da sidebar combine com o app-background;
- o conteúdo principal use o mesmo fundo em todos os módulos;
- não exista uma quebra abrupta entre sidebar e página;
- item ativo continue com brand-primary;
- tema claro e escuro tenham contraste consistente.

==================================================
22. TROCA DE TEMA
==================================================

A troca deve alterar apenas:

- cores;
- fundos;
- bordas;
- sombras;
- gráficos;
- estados visuais.

Não deve alterar:

- layout;
- altura;
- largura;
- espaçamento;
- posição;
- tamanho de fonte;
- tamanho dos cards;
- tamanho dos ícones;
- gráficos;
- filtros;
- estado dos componentes.

Não recriar a página ao trocar o tema.

Não perder:

- filtros;
- scroll;
- seleções;
- modais;
- processamentos;
- estados locais.

Evitar flash entre os temas.

Aplicar o tema antes da primeira renderização visível.

==================================================
23. ARQUIVOS PRIORITÁRIOS
==================================================

Revisar primeiro:

- src/app/(protected)/dashboard/page.tsx
- src/app/(protected)/campanhas/page.tsx
- src/app/(protected)/campanhas/[id]/page.tsx
- src/app/(protected)/associados/page.tsx
- src/app/(protected)/associados/[id]/page.tsx
- src/app/(protected)/eventos/page.tsx
- src/app/(protected)/configuracoes/page.tsx
- src/app/(protected)/lotes/page.tsx
- src/app/(protected)/lotes/[id]/page.tsx
- src/app/(protected)/layout.tsx

Depois revisar os componentes utilizados por essas páginas.

==================================================
24. COMPONENTES COMPARTILHADOS A CRIAR
==================================================

Criar apenas os componentes necessários para cores e cabeçalhos:

- PageSurface;
- PageHeader;
- PageHeaderActions;
- PageBreadcrumb;
- SurfaceCard;
- SemanticAlert.

Não criar novos componentes de negócio.

Não redesenhar os componentes existentes.

==================================================
25. TESTES VISUAIS OBRIGATÓRIOS
==================================================

Validar todos os módulos em:

- tema claro;
- tema escuro;
- desktop;
- mobile;
- sidebar expandida;
- sidebar recolhida.

Capturar imagens comparativas de:

- Dashboard;
- Campanhas;
- Associados;
- Eventos;
- Configurações;
- Lotes;
- detalhe de campanha;
- detalhe de lote;
- detalhe de associado.

Verificar:

- fundo geral igual entre módulos;
- cabeçalhos com mesma identidade;
- título legível;
- descrição legível;
- divisores consistentes;
- cards com contraste adequado;
- tabelas legíveis;
- erros e alertas visíveis;
- gráficos com significado preservado;
- ausência de elementos claros no tema escuro;
- ausência de elementos escuros demais no tema claro.

==================================================
26. CRITÉRIOS DE ACEITE
==================================================

A tarefa será considerada concluída quando:

1. Todos os módulos utilizarem o mesmo fundo geral por tema.

2. Nenhuma página protegida depender apenas do fundo herdado.

3. Todos os módulos principais utilizarem PageHeader.

4. Todos os títulos utilizarem a mesma cor e hierarquia.

5. Todas as descrições utilizarem text-secondary.

6. Todos os headers utilizarem o mesmo divisor.

7. As ações permanecerem na mesma posição funcional.

8. Dashboard e Campanhas deixarem de usar cores hexadecimais diretamente.

9. Associados, Eventos, Configurações e Lotes possuírem tema escuro completo.

10. Não existir `bg-white` sem equivalente semântico.

11. Não existir `text-slate-900` sem equivalente semântico.

12. Não existir `text-emerald-700` sendo usado como padrão isolado de módulo.

13. O tema claro não parecer excessivamente branco ou fluorescente.

14. O tema escuro não parecer excessivamente preto ou saturado.

15. Os gráficos preservarem as mesmas cores semânticas.

16. Os ícones existentes permanecerem exatamente os mesmos.

17. Nenhum layout for alterado.

18. Nenhuma regra funcional for alterada.

19. A troca de tema não causar flash ou deslocamento.

20. O sistema parecer uma única aplicação em todos os módulos.

==================================================
27. VALIDAÇÃO TÉCNICA
==================================================

Ao finalizar, informar:

- arquivos alterados;
- tokens criados;
- classes hardcoded removidas;
- módulos migrados;
- componentes de cabeçalho criados;
- resultado do tema claro;
- resultado do tema escuro;
- resultado do typecheck;
- resultado do lint;
- resultado dos testes;
- resultado do build.

Confirmar explicitamente:

- nenhum ícone foi alterado;
- nenhum layout foi redesenhado;
- nenhuma funcionalidade foi modificada;
- nenhuma regra de negócio foi alterada.

Antes de implementar, apresente um plano curto contendo:

1. cores hardcoded encontradas;
2. módulos sem suporte completo ao tema escuro;
3. tokens que serão criados;
4. padrão do PageHeader;
5. sequência de migração;
6. riscos visuais;
7. estratégia para não alterar o layout.