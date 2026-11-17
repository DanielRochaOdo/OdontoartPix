# Piloto conservador: duas gravacoes simultaneas (ODONTOPIX)

## Objetivo

Comparar 1 x 2 gravacoes **sem mudar** o ERP, a sincronizacao geral, as
regras canonicas ou os limites de recursos do banco.

Baseline da VPS (17/11/2026): `processing_settings` = 1; PostgreSQL
limitado por Docker a 2 vCPUs / 2 GiB; 17 conexoes (2 ativas, 15 idle),
0 locks observados; CPU PG de 137% a 205%; 160 parcelas por ciclo
levavam 19-36 s, com persistencia media de 117 a 227 ms. O mecanismo
de deduplicacao da sincronizacao geral ja estava ativo.

## Implementacao opt-in

`PROCESSING_PERSISTENCE_PILOT_ENABLED=false` por padrao.

Se `true`, executa com **2** slots globais de persistencia
apenas quando TODAS as condicoes abaixo forem verdadeiras:

- Pipeline V2, Sliding Window V1 e V2 ativos;
- job originado manualmente, no escopo de **um lote**;
- job com total de 2 ate 160 registros;
- job sem `general_sync_run_id`, sem alvo individual e sem replay de erros;
- configuracao real de persistencia ainda igual a **1**;
- nao existe sincronizacao geral ativa, enfileirada, pausada ou cancelando;
- a consulta de verificacao de seguranca ao banco foi bem-sucedida.

Se qualquer condicao falhar, o limite efetivo continua sendo 1.
Falha ao checar sincronizacao geral tambem mantem 1. A flag nao dispara
job e nao altera a configuracao persistida no banco.

A decisao e feita **por job**; o Sliding Window V2 usa seu limitador
global de persistencia existente. O worker registra no evento
`[LOCAL_WORKER_STAGE_METRICS]`:

- `persistenceConfiguredConcurrency` = 1;
- `persistenceConcurrency` = 2 (somente no piloto);
- `persistencePilot` = true (somente no piloto);
- `elapsedMs`, `erpAverageMs`, `erpMaxMs`,
  `persistenceAverageMs`, `persistenceMaxMs` para comparacao.

O processamento de pagamentos, parcelas em multiplos lotes, retries,
deduplicacao da sync geral, transacoes e financeira nao foram alterados.
A configuracao de 1 continua a valer para sincronizacoes gerais, jobs
grandes, agendamentos, reprocessamentos e producao normal.

## Publicacao e ativacao segura

1. NAO publicar nem reiniciar worker durante sincronizacao geral ativa.
   Verificar se `general_sync_runs` nao tem status
   `queued/running/paused/cancelling`. A ultima execucao informada
   estava `running`, portanto aguardar a conclusao natural.
2. Publicar pelo `docker-safe-deploy.sh` ja existente **apos**
   a sincronizacao encerrar. Isso nao ativa o piloto (flag default false).
3. Verificar o EnvironmentFile efetivamente carregado pelo
   `odontopix-worker.service` com `systemctl cat odontopix-worker.service`
   (nao imprimir segredos). Inserir
   `PROCESSING_PERSISTENCE_PILOT_ENABLED=true` **somente nesse arquivo**,
   em manutencao, depois de o worker estar ocioso. Nao alterar a variavel
   `PROCESSING_PERSISTENCE_CONCURRENCY` ou os dados do banco.
4. Rodar um **job manual de um unico lote e no maximo 160 registros**,
   com o sistema monitorado. Um job manual de maior porte
   automaticamente permanece em 1. Se houver general sync ativa,
   automaticamente permanece em 1.
5. Conferir os logs e metricas e inspecionar CPU/throttling do Docker,
   locks do Postgres, tempos de telas e integridade financeira.
   Comparar com baseline semelhante executado com piloto desativado.
6. Desativar retirando a flag ou definindo
   `PROCESSING_PERSISTENCE_PILOT_ENABLED=false`. Novas invocacoes do
   worker usarao 1. Nunca interromper transacao em execucao
   exclusivamente para trocar a flag.

### Consultar metricas do piloto

```bash
journalctl -u odontopix-worker.service --since "1 hour ago" --no-pager -o cat |
  grep -A 18 '\[LOCAL_WORKER_STAGE_METRICS\]' | tail -n 120
```

### CPU e throttle do container

```bash
docker stats --no-stream odontopix-db-1
docker exec odontopix-db-1 sh -c 'cat /sys/fs/cgroup/cpu.stat; sleep 10; cat /sys/fs/cgroup/cpu.stat'
```

Nao executar sincronizacao geral grande como experimento. Nao alterar
`NanoCPUs=2000000000`, limites de memoria, concorrencia ERP,
`PROCESSING_PERSISTENCE_BATCH_SIZE` ou qualquer esquema do banco.

## Critério de aceite e rollback

Manter piloto somente se reduzir a duracao de ciclos comparaveis,
sem crescer de forma significativa throttling, latencia do dashboard,
locks, erros/retries e sem divergencia de pagamentos/parcelas.
Se qualquer indicador se deteriorar, desativar o piloto.
Nenhuma alteracao SQL ou migration e necessaria.
