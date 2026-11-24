# 047 — Shadow incremental (experimental, não autoriza produção)

## Evidência e escopo
Em 24/11, a 046 processou 37.838 registros e reaproveitou 129.764 em 39min09s,
sem erros registrados. As auditorias encontraram zero divergências nos 205.359
vínculos e 40 lotes. O intervalo de medição (42min25s, inclui ociosidade)
registrou 1.132.647.088 linhas sequenciais e 14.544 varreduras; a referência
de 112,34 milhões/min da arquitetura anterior não foi pareada por parcela.
EXPLAIN de três lotes grandes: 78.051 linhas canônicas, 57.546 vínculos,
41,435 ms. Não atribuir todas as varreduras ao recálculo.

## Correção independente
DELETE de Associados por parcela não encontrada usava uma agregação própria
sobre os vínculos. Agora chama recalculateBatch no mesmo client/transação,
preservando as regras de autorização, exclusão lógica e revalidação.
O cálculo da 044 permanece a única fonte oficial.

## Candidato 047
- Estado inicial desativado. Triggers AFTER capturam somente campos que afetam
  a contribuição; identificadores de vínculos e parcelas são deduplicados por
  transação. Mudanças operacionais e financeiras têm cobertura separada.
- Flush diferido na confirmação: expande os alvos canônicos para os vínculos
  ativos atuais, inclusive os em processamento, subtrai a contribuição anterior
  e soma a atual. Uma trava advisory transacional global serializa APENAS
  gravações auxiliares. Leitura READ COMMITTED após adquirir a trava; nenhuma
  nova trava de linha nas tabelas oficiais. Não altera a 044/046 nem o worker.
- A tabela auxiliar não possui FK para as fontes de propósito: a contribuição
  anterior precisa sobreviver a exclusões em cascata até o flush. Elimina
  contribuições removidas e lotes vazios; auditoria inclui lotes órfãos.
- Auditoria independente agrega diretamente vínculos e canônicas, compara
  nove componentes (incluindo processamento/espera) com totais shadow e
  sete totais oficiais + status. Diferenças oficiais em mudanças operacionais
  intermediárias podem existir até o recálculo 046; não confundir com
  divergência shadow. Auditar também individualmente as contribuições.
- Sem ativação do candidato como fonte oficial. Não existe flag de promoção.
  Qualquer falha do shadow aborta a transação, nunca confirma parcialmente.
  Overhead de triggers/filas, contenção da trava, WAL e deadlocks devem ser
  medidos. Não chamar SET CONSTRAINTS ... IMMEDIATE no fluxo normal; a
  serialização pressupõe flush ao commit. Não suportar REPEATABLE READ,
  SERIALIZABLE, desativação de triggers ou replicação que os ignore.
- TRUNCATE das fontes é recusado enquanto shadow habilitado. Não modificar
  diretamente as tabelas auxiliares. Bootstrap/rebuild exige manutenção
  exclusiva, sessões escritoras drenadas, READ COMMITTED, locks NOWAIT e
  usuário administrador. Nenhuma autorização para rodar na produção.
- Funções de captura/flush usam SECURITY DEFINER com search_path restrito e
  nomes qualificados, pertencem ao executor da migration. A ativação e a
  leitura da auditoria são administrativas; não conceder superusuário ao app.
  Validar proprietário, permissões efetivas (inclusive default privileges)
  e schema CREATE antes de deploy. A migration cria triggers nas tabelas
  existentes e pode exigir administrador, como na 046.

## Laboratório isolado (não executar em produção)
Aplicar migrations com administrador; executar testes CI e os smoke tests da 046.
Em janela sem escritores, com sessões antigas encerradas:
```sql
select public.set_batch_totals_shadow_v1(true);
select * from public.batch_totals_shadow_audit_v1
where shadow_differs or orphan_batch or official_differs;
select count(*) from public.batch_totals_shadow_dirty;
select count(*) from public.batch_totals_shadow_transactions;
-- Desativação/rebuild só em manutenção, após exportar evidências:
select public.set_batch_totals_shadow_v1(false);
```
Comparar contribuição por vínculo (FULL JOIN, incluindo ausentes/órfãos)
com cálculo independente, antes/depois de cada caso. Nenhuma divergência
shadow, nenhum órfão, nenhuma pendência visível após commit. Para comparar
oficial, usar estado ocioso e verificar antes de qualquer reparo.

## Portões
1. CI PostgreSQL, testes, typecheck, build. Testes incluem bootstrap, saldo
   residual e vínculo processing, exclusão lógica, transferência, cascata,
   idempotência, rollback após flush e sobreposição real de commits.
2. Smoke real ERP/worker: baseline 046 e 047 shadow, retry, crash/recovery,
   acordos, exclusões, reabertura, lotes vazios, importação, cancelamento,
   concorrência com API e papel real de aplicação. Revisar todos os caminhos
   dinâmicos e eventuais escritores não catalogados.
3. Benchmark representativo: ~78 mil canônicas, ~205 mil vínculos, 40 lotes,
   ~38 mil processamentos e ~130 mil reaproveitamentos; medir overhead
   desligado/ligado, delta de leituras por resultado, CPU, WAL, locks, p95,
   deadlocks, duração. Shadow ainda executa a 046, não promete ganho.
4. Somente após paridade comprovada, projetar a promoção incremental em PR
   separado. Garantir reparação integral automática/administrativa com
   reconstrução das contribuições, ordem de locks, reversão e comparação
   controlada. Meta >=90% de redução por resultado confirmado em relação à
   arquitetura pré-046, não comprovada.
5. Sem merge, deploy ou ativação sem autorização explícita.
