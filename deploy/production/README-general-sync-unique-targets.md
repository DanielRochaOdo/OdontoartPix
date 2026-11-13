# Sincronizacao geral: consulta unica por parcela canonica (opt-in)

## Comportamento

Uma parcela com `target_installment_ref_id` compartilhado em ate cinco lotes
gera uma unica consulta **bem-sucedida** por `general_sync_run_id`, mesmo
que o lote seguinte ainda esteja elegivel. Falhas tecnicas continuam sujeitas
a retentativas; falhas nao sao promovidas a resultados reutilizaveis.

A consulta bem-sucedida ja promove a verdade financeira por meio dos triggers
canonicos existentes; os lotes seguintes apenas registram que o vinculo foi
atendido, sem alterar valores, status financeiros ou snapshots do ERP.

A identidade e a UUID da parcela canonica, nao apenas o numero textual da
parcela. A chave primaria do registro temporario de sucesso e
`(run_id, target_installment_ref_id)`.

`general_sync_run_batches.reused_count` conta vinculos reaproveitados de
outros lotes. `processed_count` e `success_count` continuam indicando
consultas realmente processadas por jobs. A tela ja soma
`processed_count + reused_count` para o progresso.

## Seguranca e operacao

- Migration 036 adiciona `processing_jobs.general_sync_run_id` e
  `general_sync_run_installments`. Nao altera tabelas financeiras nem a V2.
- `GENERAL_SYNC_UNIQUE_TARGETS_ENABLED=false` por padrao.
- Para opt-in **apos** testes e janela controlada, passar
  `-e GENERAL_SYNC_UNIQUE_TARGETS_ENABLED=true` no `docker exec` do
  worker, mantendo as tres flags do Sliding Window V2.
- Nao alterar o servico enquanto um job ou sync estiver rodando.
- Rollback: remover apenas a variavel de ambiente no worker; a V2 e a
  estrutura financeira permanecem inalteradas.
- O mapa de sucessos persiste em pausas e retomadas, e e eliminado ao
  concluir ou cancelar a sincronizacao.
- Sem armazenar valores financeiros no mapa: o canonico e a unica fonte
  para montantes e estados financeiros.

## Testes obrigatorios

- Testes PostgreSQL `tests/general-sync-unique-targets-db.test.ts`
  usam rollback, cobrindo paid, unpaid, agreed, excluded, 4 lotes,
  reprocessamento do mesmo lote, retentativas e colisao de codigos
  entre associados.
- CI: migracoes, preflight, typecheck, testes e build.
- Antes de ativar em producao, executar ciclo controlado e comparar:
  `SUM(general_sync_run_batches.processed_count)` (consultas ERP)
  contra `SUM(reused_count)` (vinculos aproveitados), e total atendido
  contra `SUM(record_count)`. Aferir CPU do banco.
- A nova regra nao deduplica consultas manuais independentes da
  sincronizacao geral.

## Correcao de vinculacao e elegibilidade (migration 037)

- `general_sync_run_id` passa a identificar **todos** os jobs de uma
  sincronizacao geral, mesmo quando a deduplicacao esta desativada.
  A flag controla apenas o registro de sucessos e o reaproveitamento.
- O worker registra `[GENERAL_SYNC_DEDUP_MODE]` junto a cada lote com
  runId, batchId e a flag efetivamente reconhecida.
- Uma fotografia transacional dos links inicialmente elegiveis e gravada na
  tabela `general_sync_run_eligible_links`. Isso impede que links
  anteriormente terminais sejam contados como reaproveitados quando
  outro lote promove o estado canonico da parcela.
- A fotografia e removida ao concluir ou cancelar. Pausa e retomada
  preservam a fotografia. A migration 037 deve ser executada com o
  proprietario do banco da VPS (postgres_admin).
- A ativacao experimental continua separada do deploy.
