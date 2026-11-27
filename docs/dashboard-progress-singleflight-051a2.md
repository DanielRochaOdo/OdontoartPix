# 051-A.2 — SingleFlight do progresso financeiro

Base: PR #180 / 77af32964387. A alternativa E permanece byte a byte igual.
O diagnóstico 051-A.1-R encontrou 98,25% dos buffers na seleção dos vínculos
nas três amostras. A medida pós-deploy anterior teve 4.115 chamadas e
716.140.028 acessos a buffers. Esses dados motivam reduzir consultas repetidas,
não justificam uma estimativa de sobreposição real.

## Contrato

- Os dois endpoints continuam autenticando e autorizando individualmente os
  três perfis existentes. Todos possuem o mesmo escopo financeiro global;
  se autorização por campanha/usuário for introduzida, revisar a chave antes
  de reutilizar este mecanismo.
- Chave: UUID do run + conjuntos separados de UUIDs de campanhas e lotes
  (minúsculos, únicos, ordenados). Filtros vazios não equivalem a filtrados.
- Singleton versionado em globalThis, somente no processo Node. Não compartilha
  entre processos, containers ou réplicas. A SQL e os contratos HTTP não mudam.
- Somente promises pendentes; remoção na resolução ou rejeição, antes de
  entregar aos consumidores. Sem TTL, cache concluído, temporizador ou
  mudança na frequência de atualização. Cada nova leitura após a conclusão
  consulta o banco. Um leitor concorrente pode receber o snapshot iniciado
  por outro leitor; não é uma garantia de leitura após a própria chegada.
- Limite de 64 chaves retidas; nova chave acima do limite executa sem compartilhar.
  Não é um limitador de concorrência do banco. A duração da leitura continua
  sujeita aos limites já existentes no pool/banco; não introduz timeout.
- Sem alterações em migrations, workers, SSE, polling, regras financeiras,
  flags ou configuração operacional.

## Observabilidade

A cada 500 solicitações recebidas pelo helper, log acumulado por PID:
[051A2_PROGRESS_SINGLEFLIGHT] com requested, executed, shared, bypassed,
succeeded, failed, pending. Não contém IDs, filtros, dados pessoais ou resultados.
requested = executed + shared; bypassed é subconjunto de executed.
succeeded/failed contam execuções, não consumidores. pending conta chaves
retidas, não todas as execuções em andamento. Os logs são amostras acumuladas
durante a admissão, podem conter execuções ainda em andamento; não somar
linhas cumulativas. Reinício do processo reinicia contadores.

## Testes e benchmark

`npx vitest run tests/dashboard-progress-singleflight.test.ts tests/dashboard-progress-singleflight-routes.test.ts`
`npx tsx scripts/benchmark-dashboard-progress-051a2.ts`

Benchmark com o helper real e I/O simulado de 5 ms, 100 ondas por cenário.
Valida número exato de execuções e igualdade dos resultados, sem PostgreSQL,
ERP, rede HTTP ou concorrência do worker. Latência medida é do ensaio
sintético; não representa throughput real. CI geral também roda testes
financeiros existentes, incluindo SQL em PostgreSQL.

## Homologação posterior (não autorizada por este PR)

Após CI e merge autorizado, preparar imagem e baseline como na 051-A.1.
Comparar chamadas SQL do queryid 3772668403793103944, buffers por parcela,
duração, erros e auditoria; avaliar deltas dos logs por PID, sem somar totais
cumulativos. Validar filtros, pausa, retomada, cancelamento, conclusão e
múltiplas abas. Não pressupor 50% de economia nem aprovar por benchmark
sintético apenas. Rollback pela imagem anterior, sem restauração do banco.
