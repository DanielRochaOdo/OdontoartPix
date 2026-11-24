# Persistência agrupada transacional — 24/11/2026

## Evidência e escopo
A coleta no servidor físico odontoart às 10:33:57 (Fortaleza) mostrou 715 chamadas de
`recalculate_batch_totals_many`, 206.738,54 ms de tempo próprio, 98,72% do
tempo próprio das funções monitoradas. Às 10:40:40 havia 4.456 chamadas e
1.275.495,42 ms de tempo próprio. Isso inclui espera por locks e não é CPU.
As varreduras de member_target_installments acumulavam 17.262.990.474 linhas.
Não é possível atribuir todas as varreduras à função apenas por essas coletas.

## Alteração
- Migration 046 mantém integralmente o cálculo, as fórmulas e os locks da 044.
  Propagação passa por função que, por padrão, recalcula imediatamente.
- Opt-in `PROCESSING_GROUPED_PERSISTENCE_ENABLED=true`: somente job de lote de
  sincronização geral com Sliding Window V2, sem piloto de persistência.
- Cada grupo de até 20 resultados (limitado por persistenceBatchSize e
  concorrência de consulta) usa uma única transação. Espera para formação do
  grupo: até 150 ms se não houver outro grupo ocupando o gravador.
- Um gravador de grupos por job nesta etapa. Configuração de concorrência
  persistida e consultas ERP permanecem intactas. Claims e persistência
  agrupada adquirem primeiro o lock do job; não há chamada ERP na transação.
- A transação preserva a persistência de cada resultado, registro de dedup,
  contadores, ownership e triggers. Registra IDs de lotes afetados em tabela
  transacional deduplicada; recálculo da união antes do commit. Constraint
  trigger diferido recusa commit com IDs pendentes. Não há fila durável ou
  reparo eventual. As demais chamadas continuam imediatas.
- Se o grupo falhar, o worker usa o caminho individual original por item,
  protegido pelo claim_token; não marca todos como erro ERP automaticamente.
  Falhas transitórias continuam com as regras existentes. Um resultado só
  recebe confirmação em memória após commit.
- A tabela pendente deve permanecer vazia fora das transações; não apagar
  manualmente pendências nem desativar o trigger. Não há dados financeiros
  novos nem alteração das fórmulas do Dashboard.

## Homologação obrigatória (não é autorização de merge/deploy)
1. CI: migrations PostgreSQL, typecheck, todos os testes e build.
2. Laboratório isolado, após preparar e iniciar o ambiente conforme
   financial-persistence-local-lab.md, parar watcher e executar:
   `npm run lab:migrate`, `npm run lab:test`,
   `npm run lab:smoke:general` e `npm run lab:smoke:general -- --grouped`.
   Verificar relatórios separados, paridade financeira, lote compartilhado,
   parcial, estados terminais, HTTP 503, interrupção e recuperação.
3. Benchmark representativo com aproximadamente 78 mil parcelas canônicas,
   lotes e compartilhamentos equivalentes, ~38 mil consultas por execução,
   comparar baseline com 3 gravações vs. modo agrupado. Medir deltas de
   pg_stat_user_tables (seq_scan, seq_tup_read, idx_scan, n_tup_upd),
   pg_stat_user_functions (calls, self_time), tempo total, ERP calls,
   recálculos/resultado confirmado, CPU, WAL, locks, retries, p95 de transação.
   Sem reset de estatísticas em produção. Meta proposta: >=90% menos linhas
   sequenciais por resultado confirmado, sem divergência. Não é ganho medido.
4. Verificar totals por cálculo independente, inclusive saldo residual de
   paid, vínculo em processamento, excluídos logicamente, reparo de totais
   defasados, cancelamento, conflito de ownership, rollback e retomada.
5. Revisar proprietário e grants da função e tabela antes de migrar em
   produção. Aplicação por administrador pode ser necessária (função da 044
   historicamente de postgres_admin). Exigir backup verificado, worker ocioso,
   manutenção controlada e aprovação explícita. Não executar automaticamente.

## Métricas e reversão
LOCAL_WORKER_STAGE_METRICS informa persistenceGrouped, persistenceGroupSize,
persistenceGroupedTransactions, persistenceGroupedItems, persistenceGroupedFallbacks.
O tempo médio de persistência por item inclui espera no buffer no modo agrupado.
O tamanho efetivo deve ser medido por items/transactions (não pelo limite).
A configuração padrão ausente/false mantém a persistência individual e
recálculo imediato. Para reverter o opt-in, encerrar o ciclo com segurança e
remover a flag (ou false) nas novas conexões/processos do worker; nenhuma
migração destrutiva é necessária. Validar que não há pendências e que os
totais conferem. O caminho incremental de totais não está nesta entrega.
