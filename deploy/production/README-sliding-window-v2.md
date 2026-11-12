# Sliding Window V2 (experimental, opt-in)

A V2 **nao** substitui a implementacao em producao por padrao. O worker
atual permanece na V1 com grupos de oito faturas ate que a nova flag seja
explicitamente habilitada em uma janela de teste aprovada.

## Diferencas

- V1: ate 80 itens reclamados simultaneamente em lanes de ate 8; cada lane
  espera seu grupo terminar para buscar o proximo.
- V2: reserva inicial de ate 80 itens em uma transacao; ao terminar
  **consulta ERP + persistencia**, cada vaga reserva uma proxima fatura.
  As reservas individuais usam uma fila serializada, mantendo o limite
  de concorrencia ja configurado.
- V2 primeira passagem: itens pending/queued/aguardando aptos.
- V2 segunda passagem: itens retrying aptos (respeitando next_retry_at)
  e, nos jobs explicitamente autorizados, erros solicitados para
  reprocessamento. Esta fase so inicia depois de toda a primeira fase
  terminar; ao atingir limite por ciclo ou limite de tempo, continua
  no proximo tick do worker.
- As tentativas seguem os limites de max_attempts e o backoff existente;
  falhas definitivas continuam exigindo reprocessamento explicito.
- Cancelamento, lock do job, claim_token, limites de persistencia e
  recuperacao de worker interrompido continuam a cargo dos mecanismos
  existentes. Nenhuma tabela ou migration nova.

## Habilitacao

Requer simultaneamente as tres variaveis no **processo worker**:

    PROCESSING_PIPELINE_V2_ENABLED=true
    PROCESSING_PIPELINE_SLIDING_WINDOW_ENABLED=true
    PROCESSING_PIPELINE_SLIDING_WINDOW_V2_ENABLED=true

Se a ultima estiver ausente ou false, a V1 permanece ativa.

ATENCAO: **nao alterar systemd, reiniciar worker, fazer merge ou deploy
enquanto houver sincronizacao geral ativa**. Com a automacao habilitada
existe pouco intervalo ocioso. O teste de rollout deve ser aprovado e
planejado separadamente, com as verificacoes do safe deploy e sem
interromper consultas em curso.

Rollback operacional da flag V2: voltar a
PROCESSING_PIPELINE_SLIDING_WINDOW_V2_ENABLED=false, somente em janela
segura, com o worker inativo. A imagem V1 nao precisa ser restaurada
para desabilitar o algoritmo novo.

## Sinais de validacao

    [LOCAL_WORKER_SLIDING_WINDOW_V2_METRICS]
    [LOCAL_WORKER_STAGE_METRICS] mode: 'sliding-v2'

A metrica informa primaryClaimed, retryClaimed, claimCalls e peakClaimed
e permite estimar o custo adicional de reservas no PostgreSQL. Compare
sob volume e condicoes ERP semelhantes: throughput, ERP latency/tail,
persistence latency, tempo total por lote, timeouts, memoria e CPU DB.

Nao inferir que V2 e mais rapida sem teste controlado. As reservas
individuais executam mais queries que os grupos de 8 e podem diminuir
a vazao se o banco se tornar gargalo.
