# ODONTOPIX — fase 2: piloto de 2 persistencias na sincronizacao geral

## Resultado anterior e escopo

Tres ciclos de lote manual com duas gravacoes: 399 vinculos, tempos de
10,4–13,2 s, sem erro do worker informado. No monitoramento de dois
ciclos foram vistos picos de CPU de 162,3% dos 200% permitidos ao
PostgreSQL, RAM ate 951 MiB de 2 GiB, 6 eventos de throttling
(0,495 s cumulativos), 2 amostras com um bloqueio e espera de disco
de 0–2%. O resultado e promissor, NAO certifica uma sync geral completa.

**Esta fase nao habilita 2 gravacoes em toda a sincronizacao geral.**
Ela permite 2 gravacoes somente na primeira invocacao do job da
**primeira etapa/lote nao vazio** da sincronizacao geral MANUAL,
com no maximo 160 vinculos reclamados. Todas as outras invocacoes,
lotes e sincronizacoes agendadas continuam na persistencia configurada (1).

A flag nova e independente da flag de lote manual:
`PROCESSING_GENERAL_SYNC_PERSISTENCE_PILOT_ENABLED=false`.
O deploy e o merge nao ativam o piloto.

## Guardas verificados no processo e no banco

- Requer flag nova `true` injetada no **docker exec** do worker,
  `PROCESSING_PIPELINE_V2_ENABLED=true`,
  `PROCESSING_PIPELINE_SLIDING_WINDOW_ENABLED=true`,
  `PROCESSING_PIPELINE_SLIDING_WINDOW_V2_ENABLED=true`,
  `GENERAL_SYNC_UNIQUE_TARGETS_ENABLED=true`.
- O valor efetivo do banco `processing_persistence_concurrency` deve
  continuar em 1. ERP / pool / CPU / memoria / buffer nao mudam.
- Requer `processing_jobs.processing_origin='dashboard'`,
  `processing_scope='dashboard'`, `general_sync_run_id` valido,
  sem replay filtrado e sem associado individual.
- O job deve estar sendo reclamado **pela primeira vez**
  (`started_at` nulo antes de `claimNextJob`) e com contadores
  iniciais zerados. Mesmo se o worker falhar e for reexecutado,
  o job ja com `started_at` nao pode ser rearmado.
- Limite por invocacao: 2 a 160 registros; nenhum lote seguinte
  recebe o piloto.
- Verificacao read-only do PostgreSQL exige
  `general_sync_runs.status='running'`,
  `trigger_source='manual'`, `sync_mode='full_sync'`,
  e o primeiro `general_sync_run_batches` com `record_count > 0`.
- Qualquer falha da verificacao implica **fallback seguro para 1**.
- Conflitos transitorios PostgreSQL (`40P01`, `40001`, `55P03`)
  durante persistencia deste piloto sao marcados para retentativa com
  politica vigente, nunca contabilizados como sucesso financeiro.
  Se persistencia de falha tambem falhar, o job e marcado com falha
  e segue recuperacao ja existente.

A persistencia usa o mesmo `createAsyncLimiter` compartilhado
entre lanes, `persistSuccess`, transacao financeira, gatilhos
canonicos, verificacao de `claim_token` e registro de deduplicacao.
Nenhum SQL de escrita financeira, migration ou timer foi alterado.

## Ativacao na VPS (nao automatica)

1. Aguardar que toda sync geral tenha terminado, e confirmar ausencia
   de `queued/running/paused/cancelling`.
2. Publicar o commit aprovado com
   `bash /opt/odontopix/app/deploy/production/docker-safe-deploy.sh`.
   Nao fazer deploy durante sync geral.
3. Em janela ociosa, criar a trava
   `/run/odontopix-worker-maintenance` e parar **somente**
   `odontopix-worker.timer`. Aguardar que
   `odontopix-worker.service` fique `inactive`.
   NUNCA parar o servico ativo ou o container.
4. Editar o drop-in efetivo do worker para acrescentar apenas
   `-e PROCESSING_GENERAL_SYNC_PERSISTENCE_PILOT_ENABLED=true`
   ao `/usr/bin/docker exec`. Preservar as flags ja ativas
   de deduplicacao, pipeline e lote manual.
   Na VPS atual, o arquivo de ativacao do primeiro piloto e
   `/etc/systemd/system/odontopix-worker.service.d/zzzz-persistence-pilot.conf`;
   `systemctl show -p ExecStart --value --full odontopix-worker.service`
   deve confirmar a nova variavel no comando efetivo.
   Drop-ins sao aplicados em ordem lexicografica e o ultimo
   `ExecStart` prevalece; nao criar um override `99-...`.
5. `systemctl daemon-reload`, validar todas as flags,
   `systemctl start odontopix-worker.timer`, retirar a
   trava de manutencao. Conferir timer `active`.
6. Iniciar **uma sincronizacao geral manual** num momento com
   monitoramento. O worker pode processar 2 apenas na primeira
   onda de ate 160 reclamacoes, depois volta a 1.
   Nao reprocessar ou interromper uma sincronizacao so para testar.
7. Ao fim do teste, desativar apenas a nova flag em uma janela
   segura, seguindo o mesmo processo, mesmo que o ganho seja bom.
   Um proximo piloto requer opt-in novamente. Nao subir o limite
   global de `processing_persistence_concurrency` de 1 para 2.

## Observabilidade

```bash
journalctl -u odontopix-worker.service --since "2 hours ago" --no-pager -o cat |
  grep -A 21 '\[LOCAL_WORKER_STAGE_METRICS\]' | tail -n 180
```

A primeira onda devera mostrar:
```text
mode: 'sliding-v2'
persistenceConfiguredConcurrency: 1
persistenceConcurrency: 2
persistencePilot: true
persistencePilotScope: 'general-sync-first-wave'
```

Os ciclos seguintes:
```text
persistenceConcurrency: 1
persistencePilot: false
persistencePilotScope: 'none'
```

Monitorar CPU, RAM, locks, `cpu.stat` *durante* a primeira onda;
consultar `[LOCAL_WORKER_FAILED]`,
`[GENERAL_SYNC_PERSISTENCE_PILOT_PREFLIGHT_FAILED]` e
`DB_TRANSIENT_RETRY`. Verificar se a sync conclui normalmente,
reuso de parcelas e reconciliacao financeira canônica por parcela UUID.
Uma unica leitura sem erro nao demonstra ausencia de conflitos.

### Auditoria read-only apos a primeira onda (ou depois do encerramento)

Substitua `RUN_ID_AQUI` pelo ID de `general_sync_runs` da execucao
manual, retornado pela interface ou pelo log. Execute com o usuario
PostgreSQL da VPS. A consulta nao grava nada.

```sql
WITH primeira AS (
  SELECT rb.batch_id
  FROM general_sync_run_batches rb
  WHERE rb.run_id = 'RUN_ID_AQUI'::uuid
    AND rb.record_count > 0
  ORDER BY rb.position
  LIMIT 1
)
SELECT
  COUNT(*) AS vinculos_com_parcela_canonica,
  COUNT(DISTINCT cbm.target_installment_ref_id) AS parcelas_unicas,
  COUNT(*) FILTER (
    WHERE cbm.payment_status IS DISTINCT FROM canonical.payment_status
      OR cbm.installment_amount_cents IS DISTINCT FROM canonical.amount_cents
      OR coalesce(cbm.payment_amount_cents, 0)
         IS DISTINCT FROM coalesce(canonical.paid_amount_cents, 0)
      OR coalesce(cbm.total_pending_amount_cents, 0)
         IS DISTINCT FROM coalesce(canonical.pending_amount_cents, 0)
  ) AS divergencias_financeiras
FROM primeira
JOIN campaign_batch_members cbm ON cbm.batch_id = primeira.batch_id
JOIN member_target_installments canonical
  ON canonical.id = cbm.target_installment_ref_id
WHERE cbm.deleted_at IS NULL;
```

Divergencias preexistentes ou links nao processados tambem podem
aparecer; para atribuir um problema ao piloto e necessaria comparacao
com baseline e identificacao dos registros. Uma auditoria consistente
apos a conclusao da run e preferivel a afericoes durante o processamento.

## Aceite e rollback

Aceitar somente se a onda com 2 demonstrar melhoria, nao causar
deterioracao de CPU/throttling/locks nem erros fatais ou divergencias,
e a **sincronizacao geral completa** finalizar normalmente com todos
os lotes reconciliados. Isso nao autoriza aumento automatico para 2
durante toda a sincronizacao geral.

Rollback operacional: desativar exclusivamente
`PROCESSING_GENERAL_SYNC_PERSISTENCE_PILOT_ENABLED` no proximo
`docker exec` apos worker ocioso; a flag anterior de lotes manuais
permanece ativa, deduplicacao continua ativada e o limite global fica 1.
