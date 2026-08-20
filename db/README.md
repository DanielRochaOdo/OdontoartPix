# Banco PostgreSQL próprio

O OdontoartPix usa migrations versionadas neste diretório para o PostgreSQL dedicado.

- Desenvolvimento: `odontoart_pix_dev`
- Produção: `odontoart_pix`

A migration `001_initial_auth_foundation.sql` cria somente a fundação de autenticação local: `users`, `sessions`, `audit_logs` e `schema_migrations`.

As migrations históricas em `supabase/migrations` permanecem temporariamente apenas como referência das regras de negócio durante a desvinculação. Elas não devem ser aplicadas no PostgreSQL novo.
