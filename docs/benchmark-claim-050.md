# Benchmark 050 — seleção contínua de parcelas

## Contexto e limites

Produção: servidor físico, PostgreSQL 17.12, schema 48, imagem odontopix-app:feaf42571b71. 046/047/048/049-B e deduplicação ativos; 049-A desativada. Última auditoria: 42 lotes, 222.609 vínculos, zero divergências e pendências. Sincronização 316feb77-7707-47a9-985b-121c2316de9a: 37.703 sucessos, 137.130 reaproveitamentos, zero erros, 19,81 min. Janela de medição: 704 varreduras, 56.174.976 linhas canônicas percorridas, 82.540.496 buscas por índice; claimMembers 18.462 chamadas, 378.665.266 buffers, 293,58 s acumulados. Os contadores de toda a janela incluem outras atividades; não equivalem a leituras físicas nem tempo exclusivo do worker.

Este PR é exclusivamente laboratório/CI. Sem migration 050 de produção, alteração de flags, código de runtime, merge ou deploy. A etapa 051 (Dashboard/eventos) e 052 (histórico) ficam fora do escopo.

## Protocolo

- Serviço descartável PostgreSQL 17.12 Alpine em GitHub Actions, conexão local e banco de nome fixo, schema real 48, pg_stat_statements track=all.
- Full: 79.794 canônicas, 222.609 vínculos ativos, 42 lotes; lote de estresse 20.014. Distribuição sintética de compartilhamento (68.000 alvos ativos) e massa não derivada de dados pessoais. Smoke reduzido.
- Seed e auditoria reutilizam o benchmark 049-A, com ajustes de escala. 047/048 ativos; a seleção original e UPDATE de claim são extraídos diretamente do worker.
- Três densidades de fila (10%, 50%, 90% antes de excluir terminais), 2 rodadas com ordem invertida; 5 modos: baseline, índice candidato, fase especializada, índice+fase, índice+fase+coalescência de demandas de vagas.
- Planos EXPLAIN ANALYZE com rollback apenas no laboratório: primária com limite 1/8/80, retentativa e fase all; comparação de IDs ordenados, seleção pontual e replay inexistente. Índices candidatos parciais por fase com expressão exata de ordenação.
- Trial: reserva inicial e Sliding Window V2 real nos quatro primeiros modos; candidato C agrega até 8 vagas livres por até 2 ms, sem barreira de onda. Persistência simulada com o agrupador real (20 itens, 150 ms), transações em conexões separadas, bloqueio do mesmo job, ownership e token reais. Latência ERP sintética; não executa histórico completo nem ciclo de sincronização real. C é protótipo de benchmark, não implementação operacional; retentativas são comparadas nos planos, não no trial concorrente primário.
- Cada trial valida a mesma seleção esperada, ausência de claims duplicados ou órfãos, auditorias oficiais/shadow/vínculos, pendências zero, propagação de estados, digest financeiro canônico e saldo parcial pago. Restaura a fila sintética entre trials. Índices candidatos só existem no serviço descartável.
- Relatórios JSON smoke/full com planos, buffers, chamadas, latência de claim/grupo/slot P50/P95, produtividade simulada, tamanho de grupos. 30 trials e 360 planos por escala. Falhas de paridade/escopo abortam o benchmark. Não há aprovação automática de performance.

## Critérios para decisão posterior

Meta experimental global de seleção: redução >=90% em buffers; C: redução >=70% em chamadas, sem queda sustentada de produtividade nem perda da continuidade. Comparar por densidade e rodada, não somar tempos SQL sobrepostos. A amostra sintética não prova ganhos em produção: será preciso testar cancelamento/stop/retentativas reais e integração completa antes de eventual implementação ou ativação. A implantação requer autorização separada.

## Execução

Workflow .github/workflows/benchmark-050.yml, jobs smoke e full. Evidências nos artefatos benchmark-050-smoke e benchmark-050-full. Não executar script contra produção; ele exige ambiente GitHub Actions e banco descartável dedicado.
