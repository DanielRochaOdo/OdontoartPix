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

## Instalacao na VPS, com trabalho inativo e autorizacao especifica

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
