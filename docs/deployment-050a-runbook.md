# 050-A — índices de seleção de parcelas: ativação controlada

## Decisão e escopo

PR #177 integrado à main (cc76f9ffc6c61423616dd3a7848c679c2d0a3bee).
Benchmark full PostgreSQL 17.12: seis ensaios de 160 parcelas por modo,
2.244.786 buffers baseline vs 21.782 com A (99,03% de redução), chamadas
inalteradas (81 por ensaio), tempo simulado acumulado 10.003,36 vs 3.434,75 ms.
Esses resultados não representam o ERP real nem uma promessa de desempenho.

050-A consiste exclusivamente em dois índices B-tree parciais, não únicos, de
campaign_batch_members, com a expressão de ordenação original:
batch_id, coalesce(next_retry_at,next_check_at,updated_at,created_at),
created_at, id. Os predicados correspondem ao benchmark aprovado. O SQL do
worker, anti-join de estados terminais, locks, deduplicação, histórico, flags,
047/048 e 049-A/B permanecem intactos. Nenhum índice existente é substituído.
O custo adicional de escrita e espaço deverá ser medido em produção.

Decisão deliberada: índices opt-in administrativos, FORA de db/migrations.
Schema permanece 48; a imagem atual pode usar os índices sem alteração de
aplicação. Não há ativação automática por merge, db:migrate ou deploy.
A criação convencional (não CONCURRENTLY) permite atomicidade dos dois
índices com janela de manutenção e rollback de DDL. A operação não exige
reinício do PostgreSQL nem rebuild da aplicação. 050-B/C, 051 e 052 não
fazem parte deste PR.

## Pré-condições no servidor físico (somente após autorização específica)

1. Conferir merge e SHA aprovado, checkout em diretório separado/limpo
   preservando arquivos locais, imagem e saúde atuais, schema 48 e flags.
   Registrar inventário dos índices, tamanhos, baseline pg_stat_statements,
   disponibilidade de disco, carga e ausência de jobs/sincronizações ativos.
2. Confirmar janela com usuários e outros escritores bloqueados. Em sessão
   root exclusiva, adquirir /run/lock/odontopix-safe-deploy.lock; verificar
   ausência de /run/odontopix-worker-maintenance e criar marcador sem
   sobrescrever existente. Parar timer odontopix-worker.timer; esperar
   worker odontopix-worker.service terminar naturalmente e o advisory lock
   (17483621,20260821) desaparecer. Só então parar listener
   odontopix-worker-wakeup.service e app (docker compose stop app).
   Não matar jobs, cancelar sync ou excluir registros para passar pelo gate.
   Confirmar ausência de sessões da aplicação e de outros escritores.
3. Backup pg_dump -Fc como postgres_admin em diretório protegido, conferir
   tamanho, SHA256, pg_restore -l e restauração em banco isolado antes de
   autorizar DDL. Guardar estado da imagem/Compose/serviços. Não restaurar
   backup automaticamente sobre produção.
4. Com lock de host mantido, gerar SQL integral em arquivo protegido,
   conferir conteúdo e SHA256. Executar apenas na base odontoart_pix, como
   postgres_admin, após validar conexão/identidade. O gerador não conecta
   ao banco; inclui BEGIN/COMMIT explícitos. Usar psql com ON_ERROR_STOP,
   sem -1 (o arquivo já controla sua transação).

Exemplo de etapa SQL, **não é autorização de execução** (a janela e
checkpoints acima são obrigatórios):
```bash
set -Eeuo pipefail
umask 077
cd /opt/odontopix/app
sql="$(mktemp /tmp/odontopix-050a-XXXXXXXX.sql)"
bash scripts/050a-maintenance-sql.sh activate > "$sql"
test -s "$sql"
sha256sum "$sql"
docker exec -i odontopix-db-1 psql -X -v ON_ERROR_STOP=1 -f - \
  -U postgres_admin -d odontoart_pix < "$sql"
rm -f "$sql"
```

Gate interno: superuser (sem SET ROLE), PG17, READ COMMITTED, locks
worker/migração/shadow, tabelas bloqueadas NOWAIT, schema 48, 047/048
ativos, filas e pendências vazias, auditoria inicial limpa e ausência de
objetos homônimos. A criação e validação ocorrem em uma transação. O
script compara a assinatura dos índices com índices de referência em
tabela temporária vazia, com DDL literal independente do gerador. A auditoria final ocorre antes do commit.
Time limits por statement: lock 5s e statement 120s. Não repetir às cegas.

## Validação e retomada

Em uma conexão nova, conferir os dois índices com pg_get_indexdef,
indisvalid/indisready, schema 48 e auditoria dos lotes/vínculos/pendências.
Conferir que todos os índices anteriores permanecem presentes e que
nenhuma configuração foi alterada. Se falhar, preservar manutenção e
inspecionar; não apagar índices de nome igual com assinatura desconhecida.
Subir a mesma imagem do app (sem build ou troca), conferir preflight,
health e flags; liberar listener/timer e usuários somente após validar
integridade e ausência de trabalho pendente. Preservar configurações
049-A OFF e 049-B ON e demais flags confirmadas no host.

## Reversão

Em outra janela, repetir todos os gates e backup; trocar somente o modo
do gerador para disable. O SQL verifica que os dois índices são válidos,
não únicos, não vinculados a constraints e têm exatamente a assinatura
esperada. DROP INDEX somente dos dois objetos 050-A, sem CASCADE, na
mesma transação com auditoria antes/depois. Se um objeto faltar ou for
diferente, abortar e inspecionar manualmente. Se houver divergência
financeira inicial, o gate impede a reversão automatizada: tratar como
incidente separado. Nenhum rollback de dados, alteração de schema ou
troca de imagem. Exigir aprovação explícita antes da execução.

## Homologação

O workflow operational-050a.yml usa PostgreSQL 17.12 e schema real 48.
Smoke/full executam o próprio gerador SQL e verificam recusa de job
ativo, lock ocupado, rollback sem índices, colisão de nome/assinatura,
dupla ativação e inventário restaurado. 12 ensaios e 180 planos por
escala; a meta full é >=90% de redução dos buffers de seleção, com
mesmo número de claims, mesmas parcelas selecionadas, auditorias e
digest canônico intactos. Persistência e ERP simulados; não prova
desempenho, custo de escrita em toda a carga nem janela real do host.

Depois de ativação autorizada: coletar baseline após auditoria, durante
sincronização normal medir deltas SQL por queryid/usuário/db/toplevel,
buffers e chamadas de claimMembers, duração, sucesso/min, idx_scan e
seq_tup_read por sucesso, WAL, latência de persistência/ERP, tamanho e
uso dos dois índices e auditoria financeira. Comparar com as medições
anteriores, registrando novos lotes/carga concorrente e efeitos de cache.
A 050-A não pretende reduzir a quantidade de chamadas do Sliding Window
V2: isso pertence à 050-C. Não zerar contadores globais.

## Registro da revisão 2 do PR #178

Primeiro Full reprovado na meta de desempenho (7.349.604 buffers baseline vs 7.349.797 com A; 486 chamadas por modo); Smoke e CI convencional passaram, auditorias e rollback do Full passaram. Os planos reais para limite 1 mostraram Sort e uso do índice processing_status preexistente, com 1.712/8.542/15.363 candidatos nas densidades 10/50/90%, respectivamente. Causa identificada: aspas incorretas do shell geravam literais diferentes de paid/agreed/excluded no predicado dos índices. A primeira validação de assinatura reutilizava o mesmo gerador defeituoso. Corrigido com heredoc, referência SQL independente e teste explícito de paridade com as definições literais aprovadas no #177; o CI registra também nós do plano real. A meta de redução >=90% permanece obrigatória no Full. A revisão ainda exige aprovação do CI; nenhum índice foi criado em produção.
