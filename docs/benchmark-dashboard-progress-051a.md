# 051-A.1 — benchmark de progresso canônico do Dashboard

## Continuidade (26/11/2026)
050-A homologada em produção: PR #178 integrado, main a6fbb73e9f6f83e43087c7009d9e3ece46dcfc6d; imagem
operacional feaf42571b71, schema 48, dois índices válidos. Dois runs
(61c4b185-7310-4882-92d9-35a44ba313a0 e f583bbcf-52c9-49d9-9619-3ca83f934133):
75.260 sucessos, zero erros e auditorias limpas. Claim 98,25% menos buffers
por parcela; buscas canônicas -94,07%, linhas sequenciais +214,74%.
Baseline agregado entre 13:00 e 14:21, não isolado por run.
Queryid 508654094567376938: 3.789 chamadas, 882.625.658 buffers, média
309,81 ms. Plano ocioso global: 35.073 buffers, 126,53 ms, 37.572
execuções do subplano ERP, 79.794 linhas canônicas percorridas.
Maior lote: 6.278 buffers, 33,18 ms, 16.599 execuções do subplano,
mesma varredura canônica. Registro ERP vazio: não extrapolar para carga.
Duas APIs usam getDashboardUniqueUnpaidProgress; SSE ready/change e
polling são fontes possíveis de chamadas redundantes. Sem atribuição
por endpoint ainda.

## Escopo autorizado
Somente benchmark, sem mudanças em src, migrations, worker, frontend,
flags ou produção. PostgreSQL 17.12, schema 48, serviço CI efêmero,
dados sintéticos, dois índices 050-A somente no laboratório. Full:
79.794 canônicas, 66.934 com vínculo ativo, 222.609 vínculos ativos,
5 campanhas, 42 lotes, lote stress 20.014. Distribuição de status
sintética (inclui paid parcial, agreed, excluded); não é cópia de dados
reais. Smoke reduz escala. Registro ERP do run cresce 0/10k/20k/38k
(full); outro run compartilha parcelas. Transições comprometidas de
unpaid para paid entre estágios; não é benchmark de escritores
concorrentes nem do ERP. Consultas sem cache de resultado.
A: SQL real extraído do arquivo de produção. B: CTE original + LEFT JOIN
na PK (run_id,target_installment_ref_id). C: semijoin canônico + LEFT JOIN.
D: join unpaid antes de DISTINCT + LEFT JOIN. Nenhum índice novo 051.
Paridade de IDs ordenados e flags checked, além do resultado agregado,
em snapshot read-only para cada combinação; filtros combinados e
duplicados, lote inexistente, campanha incompatível, outro run,
exclusão lógica, status NULL, paid parcial. Auditorias official/shadow,
vínculos/pendências, digest canônico antes/depois das consultas, inventário.
Nove escopos x quatro estágios x quatro variantes x três rodadas = 432
planos por escala; rotações mitigam ordem de cache, não eliminam viés.
Registra planos completos, buffers hit/read/temp, tempos e P95 agregado.
Medianas por cenário; P95 por grupo agregado, não P95 robusto de três
observações. Meta experimental >=90% de redução de buffers globais sob
registro ERP preenchido, sem regressões relevantes nos escopos.
CI exige equivalência e relatório íntegro; meta não atingida é evidência
diagnóstica explícita, não autorização para implementar. Não declarar
vencedor sem revisão dos dados, planos e regressões. Sem promessa de
redução sequencial global ou de throughput de produção.

## Próximo passo
Revisar smoke/full e CI convencional, definir alternativa ou investigar
mais. Nenhum merge/deploy automático. 051-A.2/A.3 (coalescência de
requisições e notificações) são escopos posteriores, com teste de
atualidade, filtros, troca de run, falhas e SSE/polling. 050-C, 051-B,
052 continuam independentes.

## Revisão complementar — PR #179
Primeira execução (commit 2942bbfbc3a85e271995259c5ddfe435c776974d, workflow 45869097298):
CI, smoke/full verdes; 432 planos por escala. B global full -87,87%,
todos escopos -84,50%, P95 107,368 ms vs 151,158 ms, sem regressão
de mediana de buffers full. Nenhuma variante atingiu a meta de 90%.
Smoke interseção/200 registros: A 59 vs B 115 buffers, 26 unpaid/7
checked; B fez 26 probes do registro em vez de leitura em conjunto.
Full: A/B 108/108 planos com seq scan canônico executado; C 60,
D 48. Global 38k round 0: A 143087 vs B 16595 buffers; ERP
126905 vs 413; canônico 3678 em ambos. Não confundir redução de
buffers com eliminação de varreduras sequenciais.
Complemento: E materializa somente IDs do registro do run; F usa
SQL B com índice parcial de id WHERE payment_status='unpaid'.
Índice candidato exclusivo do CI, não é migration; criado uma vez
e mantido durante transições financeiras, removido em transação
revertida durante os testes sem índice. F executa fase separada,
ordem alternada por estágio, mesma carga comprometida e paridade
de IDs e resultados; índice removido ao final e inventário validado.
Sem desabilitar seq scan nem forçar join. Registra planos com seq
scan realmente executado, loops, uso e tamanho do índice, piores
cenários. 648 planos/escala (6 variantes), 216 comparações.
DDL e custo adicional de escrita não medidos; se F for promissor,
exigir teste de churn/concorrência/WAL e autorização específica
antes de propor índice em produção. Comparação não é execução
integral do ERP. Sem mudança de código funcional.

## Seleção e implementação funcional — 26/11/2026
PR #179 merge 6e2dfc6659e45e9ee8cf1bfa0c458e1238c7d986; revisão 0cc2c4ab9cda, CI 45870143713,
benchmark 45870143522, smoke 140083130935/full 140083130527 verdes.
1.296 planos, zero divergências de paridade/auditoria. E Full:
116877 vs 976365 buffers globais (-88,03%), 431724 vs 3085002
todos escopos (-86,01%), P95 93,908 vs 132,302 ms. Smoke E:
5532 vs 14058 todos escopos, zero regressões de mediana de buffers
em ambas escalas. F eliminou seq scans canônicos mas regrediu
65,27% Full/208,93% Smoke no pior cenário; rejeitado. E mantém
108/108 seq scans Full. Meta 90% não atingida isoladamente; proposta
de aceitar E pela estabilidade, custo e ausência de DDL, continuar
com redução de chamadas em PR separado. Usuário realizou merge
do benchmark e prosseguimos conforme estratégia acordada.

PR funcional: altera somente SQL compartilhado em
src/lib/dashboard-unique-unpaid-progress.ts, sem API/worker/cache/SSE/
flags/migrations. CTE checked_run materializada, filtro run_id,
LEFT JOIN pela PK composta existente; mantém selected_targets e
unpaid_targets. Preserva snapshot de uma instrução. Baseline original
congelado em fixture SQL, benchmark verifica igualdade textual da
consulta funcional com E e usa essa consulta real no cenário E.
Testes DB com resultados esperados e paridade original, estados
financeiros e transições, exclusões, múltiplos runs. Workflow smoke/full
reexecuta seis alternativas. CI ainda deve validar o novo commit.
Sem ativação por flag: após autorização de deploy, reversão por imagem
operacional anterior validada (sem rollback de dados ou índices).
Homologação posterior: uma sincronização por baseline/final, coletor
pré-armado, localizar nova queryid pelo texto checked_run, medir
buffers/chamada e por parcela, tempos, seq scans, volume de chamadas,
auditoria financeira e comportamento dos filtros. Não exigir a queryid
antiga como identidade da nova consulta. Não iniciar deploy antes
de autorização explícita e validação CI. 051-A.2/3 separadas.
