# Refatoração da persistência financeira — laboratório local

Branch: `refactor/financial-persistence-local-20261118`.

## Implementação

Migration **044 — grouped_transactional_batch_totals**:

- Cria `public.recalculate_batch_totals_many(uuid[])` para calcular os lotes afetados em uma consulta agrupada.
- Mantém `public.recalculate_batch_totals(uuid)` como entrada compatível, chamando o cálculo agrupado.
- Altera `public.sync_target_installment_links_v1(uuid)` para reunir todos os lotes da parcela e chamar o cálculo uma vez.
- Antes de calcular, bloqueia os lotes em ordem de UUID com `FOR NO KEY UPDATE`. A agregação ocorre em um comando posterior. Em `READ COMMITTED`, isso permite enxergar transações confirmadas enquanto a chamada aguardava o bloqueio.
- Mantém reparação imediata, inclusive quando nenhum vínculo precisou mudar. Não cria fila de recálculo nem janela de atualização.
- Mantém a comparação `ROW ... IS DISTINCT FROM` para evitar reescrever totais iguais.

O worker e a importação usam `src/lib/batch-totals.ts`. O SQL duplicado no worker foi removido. Falhas transitórias de persistência seguem a política existente de tentativas quando a concorrência efetiva é maior que um; não são registradas como sucesso financeiro.

Todas as Functions SQL novas ou alteradas estão na migration 044. Não há criação de Function SQL ou Edge Function fora de migration.

## Comportamento usado como referência

A referência é a função de banco da migration **042**, vigente antes da alteração. A promoção de estado financeiro, os controles contra respostas antigas e as regras de parcelas acordadas/excluídas continuam nas funções existentes.

| Situação | Resultado |
|---|---|
| Lote vazio | `aguardando`, valores e contagens zerados |
| Há vínculo `processing` | `processando` |
| Há trabalho aguardando elegível | `aguardando` |
| Há erro elegível sem processamento/espera | `concluido_com_erros` |
| Todos os vínculos ativos estão concluídos | `concluido` |
| Processamento incompleto fora das condições anteriores | `aguardando` |
| Pagamento parcial | Valor pago e saldo pendente canônicos preservados |
| Acordada/excluída | Valor nominal preservado; não é somada como paga ou em aberto |
| Parcela em vários lotes | Todos os lotes ativos associados são reparados na mesma transação |
| Total armazenado incorreto sem mudança nos vínculos | A sincronização corrige imediatamente |

**Diferenças deliberadamente eliminadas:** o SQL antigo do worker podia marcar um lote vazio/incompleto como concluído, usava cópias financeiras dos vínculos e não recalculava `total_amount_cents`. Agora o worker adota a mesma referência canônica do banco. Isso precisa ser considerado na homologação de status. As fórmulas do Dashboard, a deduplicação de parcelas e os indicadores próprios dos jobs não foram alterados.

## Ambiente

PostgreSQL 16 local, escutando apenas `127.0.0.1:15432`. Dados, logs, senhas geradas e relatórios ficam em `.local/financial-lab/`, ignorado pelo Git.

| Banco | Uso |
|---|---|
| `odontoart_pix_lab_baseline` | Referência com migrations até 043 |
| `odontoart_pix_lab_candidate` | Comparação de desempenho com 044 |
| `odontoart_pix_lab_test` | Suíte automatizada; pode ser limpa pelos testes |
| `odontoart_pix_lab_dev` | Interface e worker com dados sintéticos |

O iniciador verifica o diretório de dados, endereço e porta do servidor. Os nomes de banco são restritos a essa lista. Não lê arquivos `.env` para escolher conexões. O Next carrega seus arquivos habituais, mas recebe as variáveis de conexão e ERP locais explicitamente, com precedência sobre esses arquivos.

O ERP simulado escuta `127.0.0.1:3101`. Ele retorna cinco situações determinísticas: pagamento integral, parcial de R$ 60 sobre R$ 100, em aberto, acordada e excluída. Não consulta o ERP real. O agendamento está desativado. A configuração de persistência **2** está apenas no banco de desenvolvimento local.

### Iniciar

Pré-requisitos: Node e dependências do projeto; binários PostgreSQL 16. No Windows, podem ser obtidos pelo [distribuidor EDB](https://www.enterprisedb.com/download-postgresql-binaries). Neste computador, já estão em `.local/financial-lab/tools/pgsql/bin`.

```powershell
npm ci
npm run lab:up
# Em uma instalação nova com binários em outro local:
# npm run lab:up -- --bin C:\caminho\pgsql\bin
npm run lab:migrate
npm run lab:seed
npm run lab:dev
```

Abrir **http://127.0.0.1:3100**. Credenciais locais geradas em `.local/financial-lab/login.json` (usuário `admin@localhost.local`). Não versionar esse arquivo.

Em outro terminal, depois de iniciar um processamento pela interface:

```powershell
npm run lab:worker -- --delay-ms=0
```

O worker drena a fila e encerra. Para novos processamentos, executar novamente. A campanha `LAB interface ...` contém 240 parcelas sintéticas compartilhadas em três lotes.

### Validar

```powershell
npm run typecheck
npm run lab:test
# Com a aplicação e o ERP simulado ligados:
npm run lab:smoke
```

O teste de fluxo autentica pela API, cria uma campanha sintética própria, enfileira 80 parcelas pela rota real e executa o worker. Confere sucesso do job, estados financeiros, saldos parciais, totais dos três lotes e resposta HTML autenticada. Mantém a campanha para inspeção na interface. Relatório em `.local/financial-lab/smoke-report.json`; detalhes do worker em `worker-smoke.log`.

Os testes de banco também usam conexões distintas e `pg_blocking_pids` para comprovar sobreposição real. Conferem totais **antes** de qualquer reparação final, em cenários de commit, rollback e resposta antiga para uma parcela compartilhada.

### Comparar desempenho

```powershell
npm run lab:benchmark -- --size=2000 --updates=200 --rounds=2
npm run lab:benchmark -- --size=20000 --updates=100 --rounds=2 --recalc-calls=15
```

Cada cenário cria sua própria campanha, três lotes compartilhados e um job comum. Mede concorrência 1 e 2 nas duas versões, alternando a ordem das versões entre rodadas. Inclui aquecimento, recálculo isolado, transações financeiras com os triggers reais e atualização do progresso do job. O custo de criar/remover as massas fica fora da medição.

O relatório registra vazão, duração total, p50/p95, tentativas, erros, contadores das funções SQL e diferenças entre totais gravados e uma consulta independente. **Não mede o tempo de ERP, contatos ou histórico completo.** O teste de fluxo separado exercita o worker completo.

Diferenças financeiras ou falhas deixam o comando com código de saída 1, inclusive quando ocorrem apenas na versão antiga. Isso é evidência da comparação, não ausência de relatório. O arquivo é atualizado ao final de cada cenário; `complete: true` indica que todos terminaram.

O p50/p95 do recálculo isolado inclui sua transação (`BEGIN`, cálculo e `COMMIT`). O tempo interno das funções é registrado separadamente em `functions.totalMs`; ele inclui chamadas internas e esperas e não representa somente CPU. Para comparar os três lotes, dividir o tempo acumulado da função de recálculo pelo número de repetições lógicas (`isolatedRecalc.calls`), sem somar pai e filha. A versão anterior faz três chamadas por repetição; a nova faz uma.

As massas recebem `ANALYZE` antes dos cálculos. Isso evita que estatísticas de tabelas anteriormente vazias distorçam a preparação do experimento. A limpeza e o `VACUUM` também ficam fora do intervalo medido.

### Encerrar

Encerrar `lab:dev` e qualquer worker em seus terminais; depois:

```powershell
npm run lab:stop
```

## Limites e decisão de uso

- Duas gravações para lotes compartilhados ainda precisam aguardar a mesma linha de resumo. A refatoração não promete dobrar a vazão.
- Ordem de bloqueio por chamada não elimina todos os ciclos possíveis entre importações, jobs e operações que alteram várias parcelas na mesma transação.
- A garantia de leitura após espera descrita acima usa `READ COMMITTED`. Outros níveis exigem tratamento próprio de repetição da transação.
- As medições locais usam dados sintéticos e hardware Windows. Não são previsão de capacidade do servidor real.
- A concorrência padrão da aplicação continua 1. A ativação de 2 em outro ambiente depende da homologação e das medições; esta branch não faz deploy.
- Aplicar 044 antes de executar a versão nova do worker. Para descartar o experimento, voltar ao código anterior e usar o banco baseline ou outro banco isolado até 043; não apagar o histórico de migrations de um banco compartilhado.

Os resultados executados neste computador serão registrados em `financial-persistence-local-results.md`.
