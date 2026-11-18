# ODONTOPIX — fase 3: duas ondas consecutivas com 2 persistencias

## Escopo do experimento

Depois de validar 123/123 sucessos e zero divergencias financeiras
entre 1.498 parcelas canonicas / 2.004 vinculos (134 parcelas
compartilhadas), testar duas ondas **consecutivas no MESMO lote**.

**Nao e habilitacao global.** A flag `PROCESSING_GENERAL_SYNC_TWO_WAVE_PILOT_ENABLED=false`
vem desligada por padrao; ativada no docker exec do worker, ela substitui
(exclusivamente durante o experimento) o antigo piloto de primeira onda
de sincronizacao geral, mesmo se sua flag anterior estiver `true`.

Somente entra no piloto se:
- Sync geral **manual, full_sync, filtrada**, com EXATAMENTE 1 lote;
- O lote (no snapshot da sync) e o job possuem 161–320 vinculos;
- Sliding Window V2 e `GENERAL_SYNC_UNIQUE_TARGETS_ENABLED=true`;
- Persistencia base continua 1 e ciclo efetivo exatamente 160 reclamacoes;
- Primeiro claim do job e estados iniciais zerados;
- A segunda onda e liberada somente se a primeira reclamou os 160,
  **persistiu 160 sucessos e teve zero erros/retentativas**, restando
  trabalho no job. Em qualquer outra situacao permanece em 1.

A migration **039** acrescenta em `processing_jobs` duas colunas
operacionais com default seguro: `general_sync_two_wave_pilot_wave=0`
e `general_sync_two_wave_ready=false`. A onda e reservada atomicamente
em uma transacao antes de iniciar as consultas; crash/retry nao pode
repeti-la. Prontidao para a segunda onda e gravada na MESMA transacao
que devolve o job para `queued`. A segunda reserva consome a prontidao.
Nao ha atualizacao de valores financeiros pelo piloto.

Em caso de problemas temporarios SQLSTATE 40P01, 40001 ou 55P03,
a rotina de retentativa existente impede sucesso artificial; se ocorrer
na primeira onda a segunda NAO e autorizada. Qualquer erro no preflight
faz fallback para 1.

## Condicoes da VPS e publicacao

- Aguardar nenhum `general_sync_runs` em
  `queued/running/paused/cancelling` antes do deploy.
- Publicar pelo script oficial `deploy/production/docker-safe-deploy.sh`.
  Ele aplica migration 039 ANTES de trocar o app em producao;
  conferir a imagem apos o deploy e a existencia das colunas.
- Manter flags atuais de deduplicacao, V2 e piloto manual e
  `PROCESSING_GENERAL_SYNC_PERSISTENCE_PILOT_ENABLED=true` inalteradas.
  A flag nova `PROCESSING_GENERAL_SYNC_TWO_WAVE_PILOT_ENABLED=true`
  e o unico opt-in desta fase e tem precedencia sobre a primeira onda.
- Com a janela de manutencao, criar
  `/run/odontopix-worker-maintenance`, parar somente o
  `odontopix-worker.timer`, aguardar
  `odontopix-worker.service` inativo. Acrescentar nova
  `-e PROCESSING_GENERAL_SYNC_TWO_WAVE_PILOT_ENABLED=true`
  no drop-in efetivo `zzzz-persistence-pilot.conf`, sem apagar flags.
  Fazer `daemon-reload`, validar `systemctl show -p ExecStart`,
  religar timer e remover trava; abortar com rollback do arquivo em
  caso de falha. **Nunca parar ciclo ativo ou container.**

## Selecionar APENAS UM lote de 161–320 registros

Consulta somente leitura para encontrar candidatos (na mesma base):
```sql
SELECT c.name AS campanha, cb.name AS lote,
       cb.id AS lote_id, COUNT(cbm.id)::int AS elegiveis
FROM campaign_batches cb
JOIN campaigns c ON c.id = cb.campaign_id
JOIN campaign_batch_members cbm ON cbm.batch_id = cb.id
WHERE cb.deleted_at IS NULL AND c.deleted_at IS NULL
  AND cbm.deleted_at IS NULL
  AND (cbm.payment_status IS NULL
       OR cbm.payment_status NOT IN ('paid','agreed','excluded'))
  AND NOT EXISTS (
    SELECT 1 FROM processing_jobs pj WHERE pj.batch_id = cb.id
      AND pj.status IN ('queued','running','paused','deferred')
  )
GROUP BY c.name, cb.name, cb.id
HAVING count(cbm.id) BETWEEN 161 AND 320
ORDER BY count(cbm.id), c.name, cb.name
LIMIT 15;
```

No Dashboard, aplicar **somente o ID desse lote** nos filtros.
Antes de iniciar, a pre-visualizacao deve mostrar
`Escopo: Filtrado`, `Campanhas: 1`, `Lotes: 1`,
`Registros: 161–320`. Se nao, NAO executar.

Os numeros de "Registros" sao vinculos elegiveis. A deduplicacao
canonica por UUID e preservada. Se houver menos de 161 registros
reclamaveis apos o reuso de resultados, o job simplesmente cai em 1.

## Auditoria e monitoramento

1. Monitorar CPU, RAM, cgroup `cpu.stat`, wait locks, disco e logs
   **durante ambas as ondas**, nao apenas apos.
2. Primeiro ciclo deve reportar:
   `persistenceConcurrency: 2`,
   `persistencePilotScope: 'general-sync-two-wave-1'`,
   `claimed: 160`,
   `persistencePilot: true`.
3. Segundo ciclo, no mesmo job:
   `persistenceConcurrency: 2`,
   `persistencePilotScope: 'general-sync-two-wave-2'`,
   `persistencePilot: true`.
4. Qualquer ciclo posterior, se houver, usa 1.
5. Para auditar, confirmar `processing_jobs.status='completed'`,
   `general_sync_runs.status='completed'`,
   contadores de sucesso/erro e
   `general_sync_two_wave_pilot_wave <= 2`.
   Conferir valores canônicos para **todos os vinculos das parcelas
   do lote de teste, inclusive em outros lotes**, como na auditoria
   anterior: status, valor original, valor pago e valor pendente.
6. Verificar logs
   `GENERAL_SYNC_TWO_WAVE_PILOT_PREFLIGHT_FAILED`,
   `LOCAL_WORKER_FAILED`, `DB_TRANSIENT_RETRY` e
   `LOCAL_WORKER_STAGE_METRICS`.

Nao interpretar duracao isolada como ganho estatistico:
o tempo de ERP muda entre os lotes; preferir latencia
de persistencia por onda + CPU/throttling + consistencia.

## Encerrar e reverter o experimento

- Apos a execucao completa (ou em caso de erro), desativar
  `PROCESSING_GENERAL_SYNC_TWO_WAVE_PILOT_ENABLED` no proximo
  `docker exec` do worker, **com a mesma janela segura**.
- Se a flag anterior de primeira onda permanecer ativada, ela volta
  a ser a politica da proxima sincronizacao. Para nao retomar
  esse piloto anterior, desative ambas as flags de sync geral.
- Nao elevar `processing_persistence_concurrency` global,
  CPU, RAM ou concorrencia ERP.
- A migration 039 e aditiva; nenhum rollback de dados financeiros
  ou reversao de schema e necessario para desligar o piloto.
