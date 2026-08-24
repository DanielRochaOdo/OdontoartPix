# OdontoartPix

Sistema web para importação de campanhas, consulta de mensalidades no ERP e consolidação financeira por parcela-alvo.

Esta branch migra o runtime operacional para **PostgreSQL próprio + autenticação local + worker local**. Supabase e GitHub Actions não fazem parte do caminho ativo de autenticação, banco ou processamento desta arquitetura.

## Arquitetura

```text
Navegador
   ↓
Next.js
   ├─ autenticação local por cookie opaco + tabela sessions
   ├─ APIs de comando/leitura
   └─ SSE /api/processing/events
          ↑
PostgreSQL próprio
   ├─ dados operacionais
   ├─ fila processing_jobs
   ├─ general_sync_runs
   ├─ processing_settings
   └─ LISTEN/NOTIFY
          ↑
worker local (systemd)
   ↓
ERP de mensalidades
```

As requisições web **não executam processamento pesado**. Ações do usuário alteram o estado/fila no PostgreSQL e o worker local consome esse trabalho.

## Regras financeiras canônicas

A consulta ao ERP usa:

```text
GET /api/Mensalidades
  ?token=...
  &CodigoAssociadoEmpresa=...
  &HistoricoCompleto=true
  &limite=200
  &pagina=1
```

Regras obrigatórias:

- sempre consultar com `HistoricoCompleto=true`;
- usar páginas de 200 registros;
- parar a paginação assim que `target_installment_id` for encontrada;
- se a parcela-alvo não for encontrada na página atual, continuar até `TotalPages`;
- somente `target_installment_id` define o estado financeiro do vínculo;
- `DescricaoRecebimento == "ABERTO"` define a parcela-alvo como `unpaid`;
- `DescricaoRecebimento != "ABERTO"` somente define `paid` quando `ValorPago >= Valor`;
- parcela-alvo não localizada após a paginação necessária é **erro**; ausência nunca define `paid` nem `unpaid`;
- erro por parcela-alvo não localizada pode ser reprocessado manualmente ou em uma sincronização completa futura;
- `Situacao` isoladamente nunca confirma pagamento;
- `Valor` é a fonte do valor da parcela e do total pendente;
- `ValorPago` é a fonte do valor recebido;
- `ValorFinal` permanece apenas como informação auxiliar da parcela;
- `DataPagamento` e `DescricaoRecebimento` são persistidos por parcela;
- falha técnica, retry ou reabertura de processamento não apaga a última verdade financeira confirmada pelo ERP.

O Dashboard usa somente a parcela-alvo para totais, pagos, pendentes, Pix e agrupamento por `DescricaoRecebimento`.

## PostgreSQL próprio

Copie `.env.example` para o arquivo de ambiente do processo e configure:

```text
DATABASE_HOST
DATABASE_PORT
DATABASE_NAME
DATABASE_USER
DATABASE_PASSWORD
DATABASE_SSL
```

Aplique as migrations em ordem:

```bash
npm ci
npm run db:migrate
```

O runner de migrations usa `schema_migrations`, transação por arquivo e advisory lock para evitar duas aplicações simultâneas.

Migrations locais atuais:

```text
001  autenticação local
002  schema operacional
003  unicidade parcela/vínculo
004  fila e prioridade
005  claims/leases do worker
006  sincronização geral
007  compatibilidade de pausa
008  cálculo do agendamento por fim da onda
009  bloqueio de login da identidade técnica
010  verdade financeira target-only e remoção das tabelas físicas de logs
011  dupla trava do scheduler + identidade técnica local
012  views de compatibilidade sem persistência de logs
013  PostgreSQL LISTEN/NOTIFY para atualização da UI
```

As migrations antigas em `supabase/migrations` são somente referência histórica e **não devem ser aplicadas** no PostgreSQL novo.

## Autenticação local

A autenticação usa as tabelas `users` e `sessions`.

- senha armazenada com hash;
- cookie de sessão contém token aleatório opaco;
- somente o SHA-256 do token é armazenado no banco;
- sessão expira em 12 horas;
- usuário inativo ou com `login_enabled=false` não autentica;
- `AUTH_COOKIE_SECURE=true` deve ser usado com HTTPS em produção.

Para criar o primeiro administrador em ambiente controlado, use o script de bootstrap documentado em `scripts/README-auth-bootstrap.md`.

## Worker local

Comandos disponíveis:

```bash
npm run worker:once
npm run worker:drain
```

O worker:

- seleciona jobs por prioridade;
- usa `FOR UPDATE SKIP LOCKED`/leases para evitar consumo duplicado;
- respeita o preset atual de `processing_settings`;
- preserva verdade financeira durante erros técnicos;
- aplica retry de timeout sem transformar falha em pagamento;
- recupera claims/jobs locais interrompidos;
- mantém Dashboard, campanha, lote e associado na mesma fila priorizada.

Prioridades:

```text
P1  Dashboard
P2  Campanha
P3  Lote
P4  Associado individual
```

## Processamento geral e agendamento

A próxima execução automática é calculada a partir do **fim real da última onda**:

```text
finished_at + scheduled_interval_minutes = next_run_at
```

O automático possui duas travas independentes e nasce desabilitado:

```text
PROCESSING_ALLOW_SCHEDULED_SYNC=false
processing_scheduler_state.scheduler_enabled=false
```

Depois da validação final do ambiente, a trava do banco pode ser habilitada explicitamente:

```sql
select set_local_processing_scheduler_enabled_v1(true);
```

Para desligar somente novas ondas automáticas, mantendo o consumo das solicitações manuais:

```sql
select set_local_processing_scheduler_enabled_v1(false);
```

## Atualização da UI sem Supabase Realtime

O PostgreSQL emite notificações de mudança por `pg_notify`. O endpoint local:

```text
GET /api/processing/events
```

mantém uma conexão SSE autenticada. Ao receber um evento, o navegador busca um snapshot atualizado das APIs internas do Next.js. Assim o painel completo de processamento continua reativo sem depender de Supabase Realtime.

As atividades exibidas no painel são derivadas do estado funcional de `general_sync_runs` e `general_sync_run_batches`. As antigas tabelas físicas `event_logs` e `consultation_logs` são removidas. A migration 012 mantém apenas views de compatibilidade **sem armazenamento**, para que caminhos antigos não causem falhas durante a transição.

## systemd

O instalador está em:

```text
deploy/systemd/install-worker.sh
```

Instalação segura, sem ativar o timer:

```bash
sudo APP_DIR=/opt/odontoartpix \
  RUN_USER=odontoart \
  ENV_FILE=/etc/odontoartpix/worker.env \
  bash deploy/systemd/install-worker.sh
```

Validação manual:

```bash
sudo systemctl start odontoartpix-worker.service
sudo journalctl -u odontoartpix-worker.service -n 100 --no-pager
```

Somente depois da validação:

```bash
sudo systemctl enable --now odontoartpix-worker.timer
```

Consulte `deploy/systemd/README.md` para o procedimento completo.

## Validação de código

A CI sobe PostgreSQL 16 descartável e executa a arquitetura local de ponta a ponta no nível de build:

```bash
npm ci
npm run db:migrate
npm run typecheck
npm run test
npm run build
```

Uma alteração só está pronta para publicação quando migrations, typecheck, testes e build passam no mesmo commit.

## Corte para produção

Antes do primeiro processamento real:

1. fazer backup dos dados que serão preservados/migrados;
2. configurar o PostgreSQL próprio e o usuário da aplicação;
3. executar `npm ci` e `npm run db:migrate`;
4. configurar as variáveis do Next.js e do worker, mantendo o scheduler automático desligado;
5. validar login, Dashboard, importação e leitura de uma campanha pequena;
6. executar `npm run worker:once` com uma fila pequena e controlada;
7. validar explicitamente a matriz financeira: `ABERTO = unpaid`; `!= ABERTO` + `ValorPago >= Valor = paid`; alvo ausente = erro;
8. validar que alvo ausente pode ser reprocessado manualmente e reaparece em uma sincronização completa futura;
9. validar Dashboard e interrupção definitiva de uma onda;
10. habilitar o timer do worker somente após a validação manual;
11. somente depois, se desejado, habilitar a criação automática de ondas com as duas travas descritas acima.

Não existe necessidade de Supabase Auth, Supabase Realtime, Supabase Cron, Vault ou GitHub Actions para o runtime desta arquitetura local.
