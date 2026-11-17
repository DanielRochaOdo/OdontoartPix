# Migração 038 — Visão Analítica na VPS

Este procedimento atende ao erro \`permission denied for table member_target_installments\` no deploy da Visão Analítica.

**Causa:** a imagem da aplicação executa \`npm run db:migrate\` com o usuário do app, que não é o proprietário da tabela canônica. A migração 038 cria uma chave estrangeira e um trigger; isso exige uma conexão de administração do schema. **Não transferir a propriedade das tabelas para a aplicação e não conceder SUPERUSER ao usuário \`odontoart_pix_app\`.**

A migração corrigida usa \`SECURITY DEFINER\` para registrar a janela dos pagamentos e concede ao aplicativo somente a leitura da tabela analítica. Execute **apenas após a correção ser incorporada ao \`main\`**.

## Diagnóstico (somente leitura)

No host da VPS, como root:

\`\`\`bash
docker exec odontopix-db-1 sh -lc 'psql -X -v ON_ERROR_STOP=1 -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}" -c "select current_user as migration_owner, pg_get_userbyid(c.relowner) as canonical_owner from pg_class c where c.oid = '\''public.member_target_installments'\''::regclass;"'
docker exec odontopix-db-1 sh -lc 'psql -X -v ON_ERROR_STOP=1 -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}" -c "select version, name, applied_at from schema_migrations where version = 38;"'
\`\`\`

Se a versão 038 já estiver registrada, **não reexecute** o SQL. Verifique se existe a tabela \`payment_hour_observations\`, se o trigger é \`SECURITY DEFINER\` e se o usuário do app possui \`SELECT\`.

## Aplicação administrativa única

1. Confirme ausência de sincronização geral ativa (o resultado deve ser **0**):

\`\`\`bash
docker exec odontopix-db-1 sh -lc 'psql -X -A -t -v ON_ERROR_STOP=1 -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}" -c "select count(*) from general_sync_runs where status in ('\''queued'\'','\''running'\'','\''paused'\'','\''cancelling'\'');"'
\`\`\`

2. Atualize o checkout com a correção já aprovada e faça **um backup validado**:

\`\`\`bash
git -C /opt/odontopix/app switch main
git -C /opt/odontopix/app pull --ff-only origin main
mkdir -p /opt/odontopix/backups
DUMP="/opt/odontopix/backups/pre-analytics-038-$(date +%Y%m%d-%H%M%S).dump"
docker exec odontopix-db-1 sh -lc 'exec pg_dump -Fc -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}"' > "$DUMP"
test -s "$DUMP" && docker exec -i odontopix-db-1 pg_restore -l < "$DUMP" > /dev/null
\`\`\`

3. Sinalize manutenção para o watchdog e pare o timer. Aguarde o serviço \`odontopix-worker.service\` ficar inativo; reexecute a consulta de sincronizações antes de prosseguir:

\`\`\`bash
mkdir /run/odontopix-worker-maintenance
touch /run/odontopix-worker-maintenance/analytics-038
systemctl stop odontopix-worker.timer
systemctl status odontopix-worker.service --no-pager
\`\`\`

4. Com o worker inativo, sem sincronizações ativas e com a versão 038 ausente de \`schema_migrations\`, aplique **somente** essa migração através do usuário administrador do contêiner PostgreSQL:

\`\`\`bash
docker exec -i odontopix-db-1 sh -lc \
  'exec psql -X -v ON_ERROR_STOP=1 --single-transaction -f - -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}"' \
  < /opt/odontopix/app/db/migrations/038_canonical_payment_hour_observations.sql
\`\`\`

5. Confira o registro, o modo seguro do trigger e o acesso de leitura do app:

\`\`\`bash
docker exec odontopix-db-1 sh -lc 'psql -X -v ON_ERROR_STOP=1 -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}" -c "select version, name from schema_migrations where version = 38; select prosecdef as security_definer from pg_proc where oid = '\''public.track_canonical_payment_hour_v1()'\''::regprocedure; select has_table_privilege('\''odontoart_pix_app'\'', '\''public.payment_hour_observations'\'', '\''SELECT'\'') as app_can_read;"'
\`\`\`

Os resultados devem mostrar a versão \`38\`, \`security_definer = true\` e \`app_can_read = true\`. Se o role de produção tiver outro nome, interrompa e adapte o \`GRANT SELECT\` ao role efetivamente usado, com privilégio mínimo.

6. Somente após as verificações, restabeleça o timer e libere a manutenção:

\`\`\`bash
systemctl start odontopix-worker.timer
systemctl is-active odontopix-worker.timer
rm -f /run/odontopix-worker-maintenance/analytics-038
rmdir /run/odontopix-worker-maintenance
\`\`\`

7. Repita o deploy controlado habitual:

\`\`\`bash
bash /opt/odontopix/app/deploy/production/docker-safe-deploy.sh
\`\`\`

Nessa nova execução, \`038_canonical_payment_hour_observations.sql\` deverá aparecer como \`[DB_MIGRATION_SKIPPED]\`, pois já terá sido aplicada corretamente.

**Em qualquer falha administrativa, não force a publicação, não recrie os contêineres do banco e não remova a trava de manutenção antes de verificar a segurança do worker.**
