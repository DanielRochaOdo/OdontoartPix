# Transição administrativa 047 → 048 (servidor físico OdontoartPix)

**Procedimento proposto; não é autorização de execução.** Não usar o deploy
genérico para cruzar 047 → 048. Não instalar ou ativar durante processamento.
Não alterar grants preexistentes de produção neste PR. A aplicação tem CREATE
no schema public e escrita em schema_migrations; são ressalvas a tratar em
mudança separada. O SQL de manutenção confirma os grants novos efetivos.
A 048 fica desativada na instalação.

## Antes do corte (checkpoints com aprovação do operador)

1. Somente após autorização de merge: verificar SHA aprovado na main, checkout
   limpo (preservar Dockerfile local, não sobrescrever arquivos locais), versão
   do banco 47, preflight da imagem atual e saúde. Registrar imagem atual,
   configuração Compose, ID do container PostgreSQL, timer, worker e listener
   e estado do agendador. Confirmar que não há outros escritores externos.
   O Dockerfile do servidor não está versionado neste PR: conferir conteúdo,
   contexto e presença dos scripts/migração na imagem antes do corte.
2. Construir a imagem compatível a partir do commit autorizado, com tag
   imutável, sem modificar Compose nem iniciar o container. Verificar a lista
   de migrations e comparar sha256 da 048 da imagem com o arquivo do checkout.
   Não usar credenciais admin na imagem, no .env ou na aplicação.
3. Confirmar término natural da sincronização (inclusive paused/queued/cancelling)
   e de jobs pendentes. Não cancelar nem excluir jobs para passar pelo gate.
   Registrar baseline de totais/contadores e configuração do scheduler.
4. Em sessão root exclusiva no host, adquirir o mesmo flock usado pelo deploy
   genérico: /run/lock/odontopix-safe-deploy.lock. Manter esta sessão e lock
   durante o corte. Criar /run/odontopix-worker-maintenance sem substituir
   marca existente; bloquear início manual de processamento e acesso dos usuários
   durante o corte, incluindo outros serviços/escritores. Parar primeiro o
   timer; aguardar worker terminar naturalmente. Confirmar que não existe
   advisory lock do worker (17483621,20260821). Só então parar
   odontopix-worker-wakeup.service e o app (docker compose stop app).
   Não parar o banco, não matar worker, não limpar o marcador se houver dúvida.
   Confirmar novamente estado inativo dos serviços, container app parado,
   ausência de conexões da role app e de jobs/runs ativos. Se não for possível
   drenar sem interromper trabalho, abortar antes de qualquer DDL.
5. Com escritores drenados, criar backup custom-format do banco via
   pg_dump -Fc como postgres_admin, em diretório root com umask 077,
   armazenar SHA256, verificar pg_restore -l e testar restauração em banco
   separado e isolado antes de continuar. Guardar cópia do Compose e da imagem
   anterior. Nunca restaurar sobre produção automaticamente.

## Instalação administrativa (checkpoint separado)

Gerar todo o SQL em arquivo ANTES de chamar psql; nunca conectar um pipe que
possa terminar prematuramente. Exemplo de comandos **somente após o corte
validado**; executar no host, no checkout do commit aprovado:

```bash
umask 077
set -euo pipefail
cd /opt/odontopix/app
sql="$(mktemp /tmp/odontopix-048-XXXXXXXX.sql)"
bash scripts/048-maintenance-sql.sh install > "$sql"
test -s "$sql"
docker exec -i odontopix-db-1 psql -X -v ON_ERROR_STOP=1 -1 -f - \
  -U postgres_admin -d odontoart_pix < "$sql"
rm -f "$sql"
```

O -1 e ON_ERROR_STOP são obrigatórios. Gate: superuser, READ COMMITTED,
lock global do worker/deleção, lock de migração, locks de tabelas NOWAIT,
lock shadow, ausência de conexões da aplicação/pendências/trabalho,
shadow habilitado, auditoria inicial limpa e schema 47. O SQL original 048
é executado sem modificações. Pós-condições na mesma transação: schema 48,
pilot off, shadow on, grants privados e auditorias zeradas. Falha aborta
a transação inteira. Timeouts são por statement (não prazo total); se
a auditoria exceder, abortar, investigar e não aumentar sem autorização.

## Troca de imagem e retorno controlado

Com schema 48 confirmado (consultar em nova conexão, não apenas log),
atualizar somente a referência da imagem app no Compose; conferir config
resolvida, manter banco intacto. Executar preflight:production na imagem
nova, com credenciais app. O preflight deve confirmar exatamente o inventário
de migrations e a identidade técnica; não contornar nem falsificar o histórico.
Iniciar app sem --build e --no-deps, conferir imagem/ID, health DB e testes
de leitura autenticados; verificar que PostgreSQL mantém o mesmo container.
Manter usuários/worker bloqueados até validar app, pilot off, shadow on,
totais/links e pendências. Só então retirar a trava de manutenção, restaurar
timer e listener conforme estado registrado, verificar ambos e liberar usuários.
Primeiro ciclo com 048 OFF; comparar totais e métricas antes de solicitar
autorização separada para ativar.

## Falha e reversão

- Antes de commit da instalação: confirmar em nova conexão schema 47, sem
  objetos 048, shadow on, auditoria íntegra. Só então recuperar Compose/imagem
  anterior, preflight, health e serviços. Se não for possível confirmar, manter
  tudo bloqueado.
- Depois de commit 048 (inclusive falha de health/preflight ou interrupção
  entre DDL e troca): **não iniciar imagem 047 e não restaurar backup
  automaticamente**. Preservar manutenção, parar app incompatível, timer e
  listener; manter schema 48 e piloto off. Recuperar a imagem compatível
  aprovada (ou correção forward homologada). Conferir preflight e auditoria,
  retomar somente após autorização. Health isolado não prova compatibilidade.
  Não apagar versão 48, não fazer DROP de objetos para enganar preflight.
- Se a 048 já tiver sido ativada e precisar reverter: drenar novamente todos
  escritores e repetir o mesmo gate; gerar SQL com modo **disable** e executar
  com a mesma transação administrativa. A função existente desativa,
  reconstrói shadow, recalcula oficiais e audita. O gate não exige auditoria
  inicial limpa para disable; pós-condição exige zero divergências. Preservar
  imagem compatível e versão 48. Se falhar, rollback e manter manutenção.
  Não reativar automaticamente.
- Ativação futura: modo **activate** somente em nova janela e com autorização
  explícita. Mesmas pré/pós-condições. A instalação nunca ativa por si.
- Recuperação de backup exige plano de incidente separado: qualquer restore
  após reabertura de escrita pode perder pagamentos/histórico. Nenhum restore
  destrutivo automatizado.

## Limites de homologação

O teste CI usa PostgreSQL real, privilégios equivalentes aos grants conhecidos,
massa sintética e o mesmo gerador SQL; testa rollback transacional, guards,
backup/restore descartável, preflight antigo/novo e reversão funcional.
Não executa systemd, troca de imagem Docker do servidor, firewall ou janela
real. Esses checkpoints são manuais e precisam de validação no host.
A ausência de conexões e locks no instante do gate não impede que um escritor
externo tente reconectar após o commit; por isso isolamento operacional
durante toda a janela é obrigatório. O script de deploy genérico atualizado
recusa transição 047→048; cópias antigas não têm essa proteção.
