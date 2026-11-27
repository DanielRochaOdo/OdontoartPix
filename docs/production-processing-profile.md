# Consolidação do perfil de produção — 27/11/2026

## Decisão e escopo

Pausar 051-A.3, 051-A.4, 051-B e 052. Preservar 047/048, 049-B,
050-A, 051-A.1 e 051-A.2. 049-A permanece desligada. Base: PR #181,
commit 165cbea0c0fcf22842e648464d785e23b21bad4a, schema 48.
Servidor físico Docker em /opt/odontopix. Não é o instalador legado
odontoart-pix-worker. Não alterar lógica financeira, SQL, migrações ou índices.

Evidência operacional: preset agressivo, configuração persistida e leitura
efetiva iguais (persistência 3, ERP/bloco/buffer 80, lote 15, delay 0,
workers configurados 10). Intervalo 1 min, scheduler true, shadow e incremental
true. Logs sliding-v2: persistenceConfiguredConcurrency=3, persistenceConcurrency=1,
persistenceGrouped=true, persistenceGroupSize=15, fallback=0 nas amostras,
até 160 itens por ciclo, piloto inativo, totalsPath=full-044.
Não confundir concorrência individual com tamanho de grupo ou quantidade de
processos. O gravador agrupado continua serial para manter a ordem de locks.
Piloto manual permanece com a flag observada true, mas só é elegível quando
a concorrência configurada é 1. Demais pilotos e profiling permanecem false.

## Fontes oficiais

- src/lib/processing-presets.ts: Agressivo com persistência 3, outros perfis
  intactos. A API existente salva o preset no PostgreSQL. Não reaplicar
  automaticamente em banco existente; preservar configurações personalizadas.
- deploy/production/processing-profile.env: perfil de ambiente não secreto,
  explícito para o servidor homologado. Não substituir arquivos de credenciais.
  Configuração persistida prevalece sobre números de ambiente. O fallback
  genérico sem configuração continua conservador (persistência 1).
- deploy/production/odontopix-worker-aggressive.conf: override Docker do timer,
  idêntico byte a byte ao temporário observado (156 bytes,
  SHA256 d2aaea42d386cf0c0ab7be029a70015c5d8f14ad671b72a29e2cd69c97dc855b).
  O listener já usa 80/80/10 por padrão; não criar outro worker ou timer.
- O scheduler continua controlado pela UI/banco, não pelo ambiente.
  Intervalo operacional observado 1 minuto, ligado. Não impor em migração.

## Instalação/atualização controlada (não automática pelo merge)

1. Backup e preflight; inventariar configuração efetiva de ambos os workers,
   Compose, flags, scheduler e auditoria. Validar schema 48, estado das
   projeções e índices 050-A. Em ambiente novo, seguir procedimentos
   aprovados de ativação de shadow/incremental e [050-A](deployment-050a-runbook.md);
   não ativar flags dependentes de banco antes da validação. Não habilitar
   scheduler antes de concluir o preflight.
2. Integrar os pares do perfil oficial ao ambiente persistente do serviço app
   Docker (incluindo o worker executado por docker exec). Revisar precedência
   de env_file, environment e overrides do systemd. Não imprimir segredos.
   Não substituir todo o .env. Preservar as demais variáveis. Em nova instalação
   aplicar Agressivo pela UI e conferir leitura efetiva 3 antes de iniciar
   a fila. Em produção existente o valor 3 já está persistido; não precisa
   de UPDATE ou migration. As flags continuam reversíveis.
3. Em janela autorizada, desligar temporariamente o scheduler pela UI,
   aguardar fim dos runs/jobs/claims/locks, usar trava de manutenção,
   parar timer, drenar worker e parar listener. Não matar trabalho ativo.
   Preservar backup do unit principal e todos os drop-ins. Verificar que
   ExecStart efetivo antes da troca corresponde ao arquivo versionado.
4. Instalar o arquivo versionado em
   /etc/systemd/system/odontopix-worker.service.d/90-aggressive.conf
   (root:root, 0644). Se existir
   /run/systemd/system/odontopix-worker.service.d/90-aggressive-test.conf,
   exigir cmp com o arquivo versionado, arquivar a cópia e retirar somente
   esse override temporário. Não remover outros drop-ins; se houver conflitos,
   interromper e revisar. Em instalação nova validar a unit base Docker.
   Executar systemctl daemon-reload e verificar ExecStart efetivo:
   docker exec odontopix-app-1 npm run worker:once -- --limit=80
   --concurrency=80 --drain --delay-ms=0 --max-cycles=10.
   Confirmar que só existe um ExecStart efetivo, sem override em /run.
5. Recriar exclusivamente app se necessário para atualizar imagem/ambiente;
   sem db:migrate neste corte de schema 48. Validar identidade do DB,
   health, preflight, índices e auditorias antes/depois. Se falhar, restaurar
   imagem, Compose/ambiente e drop-ins originais; daemon-reload; somente
   liberar manutenção com serviços saudáveis. Não restaurar dump automaticamente.
6. Restaurar listener/timer e verificar estado enabled (persistente no boot),
   remover manutenção e restaurar scheduler/intervalo original pela UI.
   Validar em operação normal: sliding-v2, configuração 3, gravador agrupado 1,
   tamanho 15, full-044, sem divergências; confirmar que reaplicar Agressivo
   não volta a 1 (primeiro em teste, não interromper run em produção).
   Não reiniciar o servidor exclusivamente para provar permanência.

## Limites da homologação

Este PR consolida configuração já observada, não mede novo ganho. Os testes de
código não provam instalação no host; exigir evidência da instalação em /etc,
ausência do override temporário e configuração efetiva após deploy. A imagem
anterior permanece opção de rollback. A operação em produção não é autorizada
pelo merge. O monitor 051-A.3 é diagnóstico de leitura e não deve ser rearmado
durante a pausa das otimizações.
