# PostgreSQL próprio

O diretório `db/migrations` é a fonte de verdade do schema PostgreSQL local do OdontoartPix.

Bancos recomendados:

- desenvolvimento: `odontoart_pix_dev`;
- testes/CI: `odontoart_pix_ci` ou `odontoart_pix_test`;
- produção: `odontoart_pix`.

## Aplicação

```bash
npm run db:migrate
```

O script `scripts/migrate-local-db.ts`:

- ordena migrations pelo prefixo numérico;
- usa `schema_migrations` para idempotência;
- aplica uma migration por transação;
- usa advisory lock para impedir dois migradores simultâneos;
- interrompe imediatamente no primeiro erro.

Nunca edite uma migration já aplicada em um ambiente persistente. Correções posteriores devem receber um novo número.

## Estado atual

- `001` autenticação local;
- `002–009` schema operacional, fila, sincronização e agendamento;
- `010` verdade financeira da parcela-alvo e remoção das tabelas físicas de logs;
- `011` identidade técnica e scheduler desabilitado por padrão;
- `012` views de compatibilidade sem persistência de logs;
- `013` notificações PostgreSQL para SSE da UI.

O scheduler local permanece desabilitado após as migrations. A ativação exige comando explícito no banco e `PROCESSING_ALLOW_SCHEDULED_SYNC=true` no worker.

O diretório histórico `supabase/migrations` não pertence ao ciclo do PostgreSQL novo e não deve ser executado aqui.
