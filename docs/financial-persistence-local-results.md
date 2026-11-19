# Resultados locais — persistência financeira

Data: 18/11/2026. Branch `refactor/financial-persistence-local-20261118`.

## Conclusão

A migration 044 manteve os totais corretos em todos os cenários executados com concorrência 1 e 2. A versão até 043 deixou um lote defasado nas duas rodadas grandes com concorrência 2, conferido antes de qualquer reparação final.

**Não foi demonstrado ganho consistente de desempenho com concorrência 2.** A referência com concorrência 1 variou bastante entre rodadas; o candidato ficou próximo de 3,3–3,6 parcelas/s. Estes dados não justificam ativar concorrência 2 em produção. O objetivo de elevar a vazão permanece aberto.

## Carga de 20 mil parcelas

20 mil parcelas canônicas, cada uma presente em três lotes (60 mil vínculos), 60 atualizações financeiras por cenário, um job comum e duas rodadas. PostgreSQL 16.16 no Windows, Node v24.12.0, `READ COMMITTED`, `fsync=on` e `synchronous_commit=on`. Nenhuma chamada ao ERP real.

| Versão | Concorrência | Rodada | Duração (s) | Parcelas/s | p95 por transação (ms) | Lotes divergentes |
|---|---:|---:|---:|---:|---:|---:|
| Até 043 | 1 | 1 | 8,07 | 7,44 | 193,99 | 0 |
| Até 043 | 2 | 1 | 7,16 | 8,38 | 361,29 | 1 |
| 044 | 1 | 1 | 18,37 | 3,27 | 521,22 | 0 |
| 044 | 2 | 1 | 16,49 | 3,64 | 858,95 | 0 |
| 044 | 1 | 2 | 17,18 | 3,49 | 449,87 | 0 |
| 044 | 2 | 2 | 17,04 | 3,52 | 911,06 | 0 |
| Até 043 | 1 | 2 | 19,63 | 3,06 | 497,86 | 0 |
| Até 043 | 2 | 2 | 6,44 | 9,32 | 285,87 | 1 |

Em todos os cenários, as 60 transações terminaram sem erro e sem retry. Isso, sozinho, não garantiu totais corretos na versão antiga: um lote terminou com 59 parcelas pagas em vez de 60 e saldo R$ 100 maior que o esperado. Na segunda rodada, o lote divergente era outro lote compartilhado, não o lote de origem.

## Recálculo isolado

Dez repetições por cenário, cada uma abrangendo os três lotes. O tempo interno abaixo é `pg_stat_user_functions.total_time` dividido por dez; inclui o trabalho interno da função. A coluna p50 inclui também `BEGIN` e `COMMIT`, portanto não deve ser tratada como tempo de CPU.

| Versão | Concorrência do cenário | Rodada | Tempo interno médio dos três lotes (ms) | p50 da transação de recálculo (ms) |
|---|---:|---:|---:|---:|
| Até 043 | 1 | 1 | 106,50 | 108,19 |
| Até 043 | 2 | 1 | 104,70 | 107,73 |
| 044 | 1 | 1 | 102,77 | 369,04 |
| 044 | 2 | 1 | 103,05 | 181,65 |
| 044 | 1 | 2 | 104,16 | 291,78 |
| 044 | 2 | 2 | 101,54 | 301,87 |
| Até 043 | 1 | 2 | 112,99 | 114,35 |
| Até 043 | 2 | 2 | 103,83 | 103,18 |

A centralização reduziu de três entradas de recálculo para uma por parcela compartilhada, mantendo a soma dos três lotes em cada persistência. O tempo interno permaneceu próximo nas duas versões. O candidato adquiriu os locks antes de calcular; as duas persistências ainda disputam esses locks. O experimento não isolou a causa de toda a diferença entre tempo interno e tempo total de transação.

## Validação funcional

- **Suíte final: 83 arquivos aprovados; 371 testes aprovados e 1 ignorado**, em 81,56 segundos.
- **Verificação de tipos aprovada:** `npm run typecheck`.
- 13 testes de banco específicos: sobreposição comprovada por `pg_blocking_pids`, commit, rollback, resposta antiga concorrente, pagamento parcial, status, acordadas/excluídas, exclusão lógica, lote vazio e reparação sem mudança nos vínculos.
- 3 testes do helper: deduplicação de IDs, manutenção da transação recebida, lista vazia e propagação de erro.
- Fluxo HTTP e worker real: login 200, enfileiramento 202, 80 sucessos, zero erros e zero retries; `persistenceConcurrency: 2` registrado no worker.
- Valores esperados no fluxo: 16 acordadas, 16 excluídas, 32 pagas (incluindo 16 parciais) e 16 em aberto; os três lotes conferidos por consulta independente.
- Página autenticada da campanha retornou HTML 200. A interação visual pelo navegador não foi verificada: o controle automatizado do navegador falhou nesta sessão.

## Evidências e reprodução

Comando da carga principal:

```powershell
npm run lab:benchmark -- --size=20000 --updates=60 --rounds=2 --recalc-calls=10
```

- Relatório completo: `.local/financial-lab/benchmark-2026-11-18T21-16-18-674Z.json` (`complete: true`).
- Fluxo completo: `.local/financial-lab/smoke-report.json` e `worker-smoke.log`.
- Suíte final: `.local/financial-lab/test-suite.log`.
- Rodada exploratória menor: `.local/financial-lab/benchmark-2026-11-18T21-09-53-577Z.json` (2 mil parcelas, 100 atualizações). Também reproduziu divergência apenas na versão antiga com concorrência 2.
- Uma preparação anterior da massa de 20 mil foi cancelada antes de completar a comparação: estatísticas de tabelas vazias causaram um plano ruim durante a criação da massa. Esses resultados incompletos foram excluídos das tabelas acima. O gerador passou a executar `ANALYZE` antes dos cálculos.

O comando principal retornou código 1 por detectar as divergências da baseline. Nenhuma divergência foi encontrada no candidato. Os JSONs e as credenciais locais estão ignorados pelo Git; este documento preserva os resultados resumidos na branch.

Para iniciar o ambiente e repetir os testes, seguir [o guia do laboratório](financial-persistence-local-lab.md).

## Alterações de banco

Migration aplicada apenas no laboratório: **044**. Functions SQL: `recalculate_batch_totals_many(uuid[])` criada; `recalculate_batch_totals(uuid)` e `sync_target_installment_links_v1(uuid)` alteradas pela migration. Nenhuma Function SQL ou Edge Function criada fora de migration.

## Correção do fluxo completo — 19/11/2026

O teste manual pelo Dashboard encontrou dois problemas que o smoke anterior de lote individual não cobria:

1. O reaproveitamento concluía os vínculos com a propagação automática suprimida e deixava o resumo operacional de três lotes desatualizado. Os valores financeiros estavam corretos. Um teste de regressão reproduziu a falha antes da correção.
2. `--drain` encerrava ao encontrar um lote totalmente reaproveitado, mesmo havendo outros lotes a percorrer ou uma sincronização a finalizar.

Correções aplicadas: recálculo do lote na mesma transação do reaproveitamento, condicionado às linhas afetadas; restauração da flag de propagação anterior; continuação de `drain` quando a orquestração conclui um lote sem criar job. Espera por retry futuro e ausência real de progresso continuam devolvendo o controle. O modo contínuo local agora é um comando versionado, `lab:worker:watch`, com parada após o ciclo atual e espera mínima entre ciclos.

### Evidências após a correção

| Cenário HTTP + worker real | Consultas concluídas | Vínculos reaproveitados | Resultado |
|---|---:|---:|---|
| Sincronização nova de 40 parcelas em 3 lotes, uma execução de drain | 40 | 80 | Concluída, zero divergências |
| Repetição da mesma campanha | 8 | 16 | Concluída, valores preservados |
| Falha HTTP 503 simulada seguida de retry real | 10 | 20 | 11 chamadas HTTP, zero erros finais e divergências |
| Interrupção real após commit e recuperação do processo | 80 | 160 | Concluída, zero divergências |
| Reexecução dos 6 lotes originais do usuário | 64 | 128 | Três resumos antigos corrigidos pelo próprio fluxo |
| Novo run com serviço já ocioso, sem lançar worker manualmente | 16 | 32 | Serviço consumiu e concluiu os 3 lotes |

- Suíte: **84 arquivos aprovados; 389 testes aprovados e 1 ignorado**, em 78,76 segundos.
- `npm run typecheck` aprovado.
- Conferência independente dos **15 lotes** presentes no banco local: zero divergências financeiras ou operacionais após a reexecução dos lotes originais.
- Os testes de banco também cobrem rollback do vínculo e resumo juntos, flag anterior ativa, retomada no mesmo lote com contador de reaproveitamento zero, reaproveitamento parcial, vínculo em processamento e exclusão lógica.
- O controle automatizado de interface continuou indisponível (`timeoutMs` na integração do navegador). Os fluxos HTTP, worker e banco foram verificados; cliques e apresentação visual não foram homologados nesta execução.

Relatórios locais: `general-sync-smoke-report.json`, `original-fixtures-recheck.json`, `worker-watch-acceptance.json` e `test-suite-flow-fix.log`, todos em `.local/financial-lab/`. A evidência anterior foi preservada em `dashboard-sync-20261119-report.json`.

Esta correção não cria migration nem Function SQL/Edge Function. Utiliza as funções já presentes na **044**. Os cenários confirmam correção funcional; não demonstram ganho de velocidade da concorrência 2.

## Observações do ambiente

O Next emitiu avisos sobre a convenção `middleware` e vulnerabilidade na versão instalada. A instalação das dependências também informou alertas de auditoria. Este laboratório não é uma homologação de segurança ou autorização de publicação da aplicação.
