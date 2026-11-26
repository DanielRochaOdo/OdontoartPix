# 049 — Finalização do worker (candidato B, não homologado)

## Referência e escopo
Base main: d50dab738218bc57156ac83ef49bbfc215ed8fa3 (PR #174). A produção tem 047/048 ativos. No intervalo controlado foram observados 5.123 projeções 048, 0 novos flushes v1, 254 ciclos registrados, 272 recálculos integrais, 1.145 seq_scans e 89.645.485 seq_tup_read na canônica. A auditoria posterior encontrou zero divergências em 41 lotes e 216.759 vínculos. Vínculos não são parcelas únicas. Esses contadores são globais do banco; não atribuem causalidade por consulta nem comprovam a meta de 90%.

O plano de agregação 044 em um lote de 20.014 vínculos leu ~78.294 canônicas (62,376 ms). A consulta de finalização simplificada, com parâmetros de sincronização geral, fez 17.487 buscas por PK e zero seq scans. Com JIT: 490,459 ms (445,591 ms de compilação); sem JIT: 75,459 ms (84,61% de redução observada, não ganho global). Cache distinto (439 blocos lidos vs zero), uma amostra por modo.

## B — mudança candidata
- PROCESSING_WORKER_FINALIZATION_JIT_OFF=true é o único opt-in; ausente ou qualquer outro valor preserva o comportamento anterior.
- SET LOCAL jit = off, no mesmo client/transação de releaseAndFinalizeJob, imediatamente antes da consulta de elegibilidade. O caminho de cancelamento/perda de ownership anterior à consulta permanece intacto.
- O SQL parametrizado, recálculo 044, filtros, lock, atualizações, flags existentes e migrations 044–048 permanecem inalterados. Não há alterações de índices ou concorrência.
- Rollback: remover o opt-in (ou usar false) no ambiente do worker e reaplicar somente pelo procedimento operacional posteriormente autorizado. COMMIT/ROLLBACK restauram a configuração de sessão automaticamente. Não alterar JIT global.
- Nenhuma ativação, merge ou implantação autorizada por este documento.

## A — inventário inicial e bloqueios
- recoverStaleLocalWork: altera processing_status e datas de retentativa dos vínculos, inclusive fora do lote atual; recupera leases.
- claimMembers: altera processing_status, attempts, claim token e retry dos vínculos em transação própria.
- persistSuccess: caminho agrupado V2 usa collect/flush 046/048 e commit diferido; outros caminhos preservam cálculo 044/046. Rollback/resultado de commit incerto pode levar a replay individual com ownership.
- persistFailure: altera processing_status e next_retry_at em transação separada, inclusive erro terminal.
- releaseAndFinalizeJob: controla ownership, stop, contagem de elegibilidade e estado de processing_jobs. failJob altera job; a próxima recuperação pode modificar vínculos.
- recalculateBatch é chamado antes de releaseAndFinalizeJob, inclusive em ciclos sem sucesso. 048 projeta somente os lotes solicitados pela transação agrupada; isso não prova que todo lote esteja atualizado após claim, falha, recuperação, reuso ou escrita concorrente.
- 046 collect_or_recalculate_batch_totals_v1 chama a 044 fora do modo agrupado. 047 mantém contribuições e agregados shadow. 048 exige locks ordenados, evento diferido e estado reconciliado. Nunca remover recálculo incondicionalmente nem usar apenas métricas de sucesso ou flag como prova de consistência.
- Inventário ainda incompleto: caminhos API/import/repair/replay, avanço de sincronização, triggers de todas as migrations e permissões precisam ser verificados antes de A. Estudar projeção transacional explícita do shadow reconciliado com locks/contingência, ou outra prova equivalente; testar inclusive ciclo sem sucesso, mudanças após último flush, rollback, recuperação, cancelamento, escrita concorrente e parcelas compartilhadas. Nenhuma implementação A neste PR.

## C — investigação
A consulta possui três NOT EXISTS na canônica. O plano observado usou PK em apenas um subplano; os outros não executaram em repouso. Eliminar verificações sem medir pode trocar buscas pontuais por leitura integral da canônica ou mudar a semântica de NULL, terminal ou replay. Não alterar C sem benchmark e equivalência em todos os parâmetros e estados.

## Homologação e limites
O teste worker-finalization-jit.test.ts verifica flag e escopo; em CI usa conexão PostgreSQL isolada, tabelas temporárias com nomes/colunas utilizados pela consulta real extraída do worker, cenários de terminal canônico, NULL, canônica ausente, erro, replay, tentativas, retentativa, lote vazio e restauração após commit/rollback. Benchmark alterna oito medições JIT on/off (78.293 canônicas, 20.014 vínculos), com paridade e EXPLAIN JSON. Massa sintética reduzida em colunas, sem triggers ou bloat real, não representa sincronização completa nem exige que o planner escolha JIT em qualquer ambiente. CI existente também executa migrations e suíte geral.

Resultados novos ainda pendentes de CI. Não aprovar merge com base apenas neste candidato. Após CI, validar a consulta no esquema real com planos representativos, registrar medianas, comparar modos 048/B e, quando A/C estiverem prontas, modos 048/A/A+B/C. Medir execução real do worker, custos por resultado confirmado, varreduras e deltas de contadores; auditar totais oficiais e shadow por lote/vínculo, além de consolidados de parcelas canônicas únicas. A meta de 90% exige referência equivalente pré-046; não foi demonstrada. Não executar novos testes em produção sem autorização.
