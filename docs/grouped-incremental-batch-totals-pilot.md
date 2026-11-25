# 048 — piloto incremental oficial na persistência agrupada

## Escopo e estado
Instalação desativada. A 047 continua em shadow e a 044/046 continua oficial.
O piloto NÃO é promoção global. Só o flush final v2 do worker agrupado pode
substituir o recálculo integral dos IDs que a 046 já coletou. API, importação,
reparos, fallback individual, claim, finalização e outros chamadores preservam
a 044/046. Dashboard e deduplicação canônica não mudam.

Evidência de produção 24/11: 75.445 processamentos bem-sucedidos em dois ciclos,
nove auditorias sem divergências (40 lotes/206.524 vínculos), zero deadlocks
registrados; recálculo integral 165,84 s de self_time contra 15,04 s nas quatro
funções shadow em intervalo de 8min53s. Não é benchmark causal.

## Protocolo
1. Worker persiste resultados em uma transação, ERP fora da transação.
2. Flush v2 desativado delega ao v1 original. Ativado: coleta os mesmos IDs,
   bloqueia lotes em UUID crescente com FOR NO KEY UPDATE (044), antes da
   trava advisory 047. Registra um evento shadow mesmo sem alteração de fonte,
   consome pendências 046 e agenda a projeção diferida.
3. No commit o evento 047 calcula contribuições e totais; a projeção 048
   exige ausência de pendências do próprio tx e a trava advisory detida.
   Atualiza somente lotes previamente bloqueados, com as fórmulas/status 044.
   Não adquire novos locks explícitos de fontes após a advisory.
4. Commit confirma fontes, shadow e oficiais juntos. Falha aborta tudo; worker
   preserva seu fallback individual. A função v2 deve ser a última operação
   do callback antes do commit; uma chamada por transação. SET CONSTRAINTS
   IMMEDIATE no fluxo normal não é suportado. Não usar REPEATABLE READ /
   SERIALIZABLE nem bypass de triggers.
5. Estado e fila privados. Somente administrador ativa/desativa. A função
   auxiliar não recebe IDs do cliente, usa a fila 046. 047 não pode ser
   desativada/reconstruída enquanto piloto ativo.

## Segurança e reversão
A instalação NÃO autoriza ativação. Aplicar como dono/admin, não como app.
Em janela exclusiva sem escritores, após backup verificado, com shadow ativo
e auditorias globais limpas, a função administrativa verifica pré-condições
e ativa o piloto. Em rollback a função desativa, reconstrói shadow se ativo,
recalcula TODOS os lotes pela 044 e audita antes de confirmar; não altera
históricos, vínculos ou valores das fontes. Não atualizar flags diretamente.
Nenhum merge, deploy, ativação ou manutenção de produção sem autorização.

## Portões de aceitação
- CI real PostgreSQL 16: migrações, testes existentes 044/046/047,
  novos testes 048 de fallback, paridade por vínculo e lote, pagamento parcial
  compartilhado, lote vazio, requisição sem alteração, rollback, locks
  concorrentes, permissões limitadas, reversão/reconstrução. A massa sintética
  inicial de 400 canônicas/1.200 vínculos, três lotes, 80 escritas em oito
  transações por modo compara a mesma carga. Exige zero chamadas integrais
  nesse caminho piloto, não em todos os caminhos da aplicação.
- Testar escala representativa (~78 mil canônicas/206 mil vínculos/40 lotes,
  ~38 mil resultados confirmados), CPU, WAL, leituras por resultado, p95,
  lock waits, fallback e produtividade com repetição e ordem alternada.
  O benchmark inicial é pequeno, não constitui teste de capacidade.
- Inventariar todos os escritores e triggers de campaign_batches, validar
  papel real de produção, concorrência API/worker, crash/recovery,
  reprocessamento, cancelamento e importação. Não presumir ausência de
  deadlocks pelo teste de duas transações.
- Só depois decidir ampliar o incremental a outros fluxos em PR separado.
  Meta global >=90% de redução por resultado sobre referência controlada
  pré-046 ainda não comprovada.

## Registro de homologação — 25/11/2026

PR #174, commit 37e6411: CI #831 e benchmark ampliado #3 aprovados.
- Execução: https://github.com/DanielRochaOdo/OdontoartPix/actions/runs/45481147566
- Duas rodadas, 38.000 escritas por modo/rodada, 78.050 canônicas,
  65.188 com vínculo ativo, 206.524 vínculos, 40 lotes e 5 campanhas.
- 046 e 047: 494.368.700 linhas sequenciais por cenário; 048: zero em ambos.
  048: 6.334 projeções por cenário, zero recálculos integrais no caminho.
- Médias 047/048: 406,52/88,14 s de duração, 401,00/75,54 s de CPU
  do container PostgreSQL e 565,38/466,34 MiB WAL. Zero divergências
  oficiais e de propagação; shadow validado quando ativo; zero deadlocks.
  Não são tempos de sincronização real do ERP.

### Homologação operacional adicionada (resultados pendentes)
Workflow .github/workflows/operational-048.yml, PostgreSQL 16 descartável,
role odontoart_pix_app sem superuser/ownership, permissões de fonte
sintéticas (não equivalência demonstrada com os grants reais de produção).
Usa API Next e worker reais, ERP HTTP simulado, fixtures pequenas,
reutilização, segunda sincronização, 503/retry, SIGKILL do worker após
commit, recuperação, DELETE HTTP concorrente com a projeção (gate de teste),
terminação de backend antes do commit, repetição idempotente e reversão.
Artefatos: relatórios, logs, inventário textual de candidatos a escrita e
definições de triggers/routines e grants no catálogo PostgreSQL. A busca
textual requer classificação manual; não prova cobertura exaustiva de SQL
dinâmico. Cancelamento/importação e demais escritores precisam ser revisados.
O benchmark ampliado agora também exige reversão auditada em cada cenário
048, fora da janela medida. As novas execuções não estão aprovadas ainda.
Nenhuma instalação, merge ou ativação autorizada em produção.

### Revisão complementar — evidência de 25/11/2026

Commit 2e58efe, CI #842, operacional #8 e benchmark #14 aprovados.
Revisão complementar #2: importação concorrente, exclusão após lock e
instalação administrativa aprovadas. Exclusão de lote antes do lock:
um deadlock real e HTTP 500 tanto com 047 quanto com 048, API revertida,
sincronização concluída, 40 canônicas preservadas e auditoria de totais
sem divergências. Risco preexistente, não regressão demonstrada da 048.
Cancelamento: a instrumentação reteve o gate enquanto esperava a API
(90 s); após liberar, logs registraram 40 sucessos e cancelamento.
Não houve auditoria conclusiva desse cenário.

Correção autorizada: as duas rotas DELETE de lote e a rota DELETE de
campanha usam worker-safe-deletion.ts. A transação tenta o mesmo advisory
lock de dois inteiros do worker (17483621,20260821) ANTES de qualquer
alteração, mantém até commit/rollback e retorna 409 PROCESSING_CONFLICT
se ocupado. Não espera o drain, não interrompe worker nem muda permissões
HTTP ou a semântica da exclusão quando livre. A chave é compartilhada
com scripts/process-local-worker.ts; a exclusão impede a entrada de outro
worker enquanto durar a transação. Decisão conservadora: bloqueia
exclusões de qualquer lote/campanha enquanto o worker local está ativo,
inclusive lotes fora do escopo da sincronização. A tentativa deve ser
repetida após a conclusão/interrupção segura do processamento. Não protege
SQL administrativo direto nem prova ausência de conflitos com todos os
outros escritores de API. Sem mudança na migração 048 ou nas fórmulas.

Testes complementares: matriz de nove jobs isolados; comprovar rejeição
409 sem efeitos antes/depois dos locks, retry 200 após saída do worker,
404 ao repetir exclusão concluída, zero deadlocks, zero divergências,
zero resíduos do lote excluído e canônicas preservadas. Testar também a
direção inversa (worker real não inicia durante exclusão com chave
adquirida). Cancelamento: enviar requisição concorrente, observar espera
ou resposta antecipada, liberar gate ANTES de aguardar resposta, exigir
cancelamento 202 e rejeição de retomada, auditar antes de novo ciclo,
preservar terminais e conferir totais finais. Importação e instalação
administrativa continuam na matriz. Resultados novos pendentes.
Nenhum merge, deploy ou mudança em produção autorizado.
