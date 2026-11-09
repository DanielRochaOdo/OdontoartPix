# Experimento de janela movel — worker ODONTOPIX

Objetivo: eliminar a espera por uma unica consulta de ~30s ao fim de cada
bloco de 80, sem ultrapassar os limites de concorrencia e sem alterar a
semantica financeira de cada parcela.

## Estado inicial e ativacao

- `PROCESSING_PIPELINE_V2_ENABLED=true` continua habilitando o pipeline
  de consulta/persistencia ja validado na VPS.
- `PROCESSING_PIPELINE_SLIDING_WINDOW_ENABLED=true` ativa a NOVA janela
  movel. Sem esta segunda variavel, o processamento segue exatamente
  o fluxo V2 anterior. O fallback para legacy permanece disponivel.
- A janela e desativada por padrao (`false` no `.env.example`).
- A flag deve ser fornecida ao PROCESSO worker. Na VPS atual o worker
  roda por `docker exec` no `odontopix-worker.service`, com ambiente
  independente do `.env` do host. Portanto, ativar somente no `.env`
  do host NAO ativa o recurso. Revise `systemctl cat odontopix-worker.service`
  antes do experimento.
- Nao altere a unit durante sincronizacao em curso.

## Contratos da implementacao

- Janela com ate `min(worker concurrency, ERP concurrency, claim limit, 100)`
  reclamacoes em voo, tipicamente **80** no preset agressivo.
- Claims distribuidos entre lanes de ate **8**; quando uma lane termina
  suas consultas E persistencias, a lane solicita outro grupo sem esperar
  as demais.
- Claims serializados no processo, preservando `FOR UPDATE SKIP LOCKED`.
- Quota por ciclo de ate **2 x claimLimit** (160 para 80), sem jamais
  haver 160 registros simultaneamente em voo.
- O novo claim verifica `locked_by`, `status='running'` e
  `stop_requested_at is null` sob lock transacional, evitando iniciar
  mais consultas depois da solicitacao de parada.
- Constrangimento de tempo: nao faz novos claims depois do
  `workerCycleBudgetMs - shutdownReserveMs - finalizationReserveMs`.
  Os registros ja reclamados sao processados/drenados.
- Persistencia global limitada pelo `processing_persistence_concurrency`,
  tipicamente 1, entre todas as lanes. Nao muda `persistSuccess`,
  `persistFailure`, retries, ownership/claim_token, metricas financeiras,
  calculo de lote ou finalizacao de job.
- O processamento de associado individual nao usa janela movel.
- Erro fatal numa lane impede novos claims, mas as outras lanes
  reclamadas terminam antes do erro ser propagado. O worker preserva
  a recuperacao de interrupcao existente.

## Medir e comparar apos a onda atual

1. Aguardar o fim da sincronizacao atual de 39.365 parcelas.
2. Desativar em Configuracoes a **Frequencia automatica** para
   evitar nova onda durante o deploy. **Nao parar o timer**,
   nem usar **Interromper processamento**.
3. Publicar a nova imagem usando
   `deploy/production/docker-safe-deploy.sh`, que recusa cortar
   com qualquer sincronizacao geral ativa. Nao mexer no DB.
4. Com app saudavel, ajustar APENAS a unit do worker numa
   janela de manutencao controlada para acrescentar
   `-e PROCESSING_PIPELINE_SLIDING_WINDOW_ENABLED=true` ao
   `docker exec` existente. Usar `systemctl edit` e preservar
   todos os argumentos e variaveis atuais, inclusive o V2.
5. Reativar a Frequencia automatica e medir pelo menos 20 minutos.
   Comparar `[LOCAL_WORKER_STAGE_METRICS]` com
   `mode: 'sliding'` aos valores anteriores:
   38 ciclos, 28,3s/bloco, latencia ERP media 6,66s,
   27/38 ciclos com chamada >=29s, 2.988 sucessos e 52 retries.
   Como o novo modo processa ate 160 por ciclo, comparar
   **sucessos/minuto**, e nao apenas duracao por ciclo.
6. Conferir `[LOCAL_WORKER_SLIDING_WINDOW_METRICS]`:
   `claimed`, `batches`, `peakClaimed` (deve ser <=80).
   Monitorar retries, timeouts, status dos jobs, latencia ERP,
   CPU, RAM e disponibilidade do banco.
7. Retorno imediato: remover a variavel experimental da unit
   (ou definir `false`). Isso restaura o pipeline V2 sem
   migration ou alteracao de dados financeiros.

A mudanca nao garante aumento de throughput: se o ERP estiver
limitando a concorrencia, enfileiramento e latencia podem subir.
Nao aumentar concorrencia para 100 durante o experimento.
