# Acionamento imediato do worker (opt-in)

O endpoint autenticado continua apenas criando a sincronizacao. Dentro da mesma
transacao, PostgreSQL publica `NOTIFY odontopix_worker_wakeup` apos o commit.
Um listener separado recebe o evento e executa o worker atual. O timer de
60 segundos permanece habilitado para recuperacao caso a notificacao se perca.

## Limites operacionais

- O listener nao recebe comandos de usuarios: a mensagem e somente um aviso.
- O worker mantem o advisory lock global existente e o controle de ownership.
- Ao reiniciar, o listener verifica jobs/runs pendentes para recuperar notificacoes.
- Concorrencia e valores financeiros nao sao alterados.
- Nao habilitar o listener durante deploy ou com sincronizacao em andamento.
- Ativar apenas quando o app implantado incluir `worker:listen`.

## Continuidade apos o limite de ciclos

- O worker permanece limitado a 10 ciclos produtivos por processo no listener.
- Quando o limite for alcancado, libera primeiro o advisory lock global.
- Depois consulta apenas a existencia de uma sincronizacao ativa ou de um job
  em execucao ou com proxima tentativa elegivel; se existir, publica
  `NOTIFY odontopix_worker_wakeup` com tipo `drain-continuation`.
- O listener encadeia uma nova execucao sem aguardar o timer de 60 segundos.
- Sem progresso, o drain encerra e NAO publica notificacao de continuidade.
  Retries agendados para o futuro continuam sob responsabilidade do timer.
- Falha ao enviar NOTIFY e registrada como aviso; nao altera estados financeiros
  nem invalida processamento concluido. O timer permanece contingencia.
- `job_enqueued` vindo da sincronizacao geral e considerado progresso mesmo
  quando nenhum item foi reivindicado naquele mesmo ciclo.

Para diagnosticar lacunas de 60 segundos, compare os eventos
`[LOCAL_WORKER_DRAIN_LIMIT_REACHED]`,
`[LOCAL_WORKER_DRAIN_CONTINUATION]` e
`[WORKER_WAKEUP_RECEIVED]` nos logs do systemd. O resultado esperado e
`notified: true` ao atingir o limite com trabalho pendente.

## Instalacao na servidor fisico odontoart, com trabalho inativo e autorizacao especifica

```bash
sudo bash /opt/odontopix/app/deploy/production/install-worker-wakeup.sh
sudo systemctl is-enabled odontopix-worker-wakeup.service
# Quando autorizado:
sudo systemctl enable --now odontopix-worker-wakeup.service
sudo journalctl -u odontopix-worker-wakeup.service -n 30 --no-pager
```

O primeiro comando apenas instala a unidade desativada. Para rollback:
```bash
sudo systemctl disable --now odontopix-worker-wakeup.service
```

O timer `odontopix-worker.timer` deve continuar `active`. O acionamento
`systemctl start --no-block odontopix-worker.service` continua disponivel
em recuperacao manual, mas nao e necessario para novos requests se o listener
estiver ativo.

## Validacao

1. Sem runs ativos, iniciar sincronizacao manual pela interface.
2. Conferir `[WORKER_WAKEUP_RECEIVED]` e `[LOCAL_WORKER_STAGE_METRICS]`.
3. Medir `general_sync_runs.started_at - created_at`; meta: poucos segundos.
4. Validar zero erros e totais por parcela canonica unica, inclusive parcelas
   presentes em varios lotes.
5. Testar parada do listener: o timer deve continuar o processamento.

As flags de concorrencia de ERP e persistencia continuam no banco e a
configuracao do worker do timer nao e modificada neste PR.
