# Impeccable para Codex — ODONTOPIX

Integração oficial: https://github.com/pbakaus/impeccable

## Instalação no checkout de desenvolvimento

Execute `bash scripts/install-impeccable-codex.sh` na raiz do repositório, em ambiente de desenvolvimento com Node.js e acesso à internet. O instalador oficial usa `--providers=codex --scope=project` e cria os artefatos da skill Codex e o hook de design. Revise os arquivos gerados e versione os artefatos compartilháveis em `.agents/` e `.codex/` em um PR.

Após a instalação, reinicie o Codex, autorize o hook do projeto em `/hooks` e execute `$impeccable init` para produzir o contexto do produto. Para documentar o design existente, use `$impeccable document`.

Não execute o instalador no servidor de produção, nem incorpore a ferramenta ao Dockerfile da aplicação. A ferramenta atua no fluxo de desenvolvimento, não no runtime Next.js.

## Segurança

O modo live é exclusivo de desenvolvimento local. Não o aponte para produção; ele pode acionar agentes com permissões elevadas. Revise os hooks antes de autorizá-los.

Este PR adiciona o instalador reproduzível e a documentação. Os arquivos gerados pela CLI precisam ser adicionados por um desenvolvedor após executar o instalador, antes de considerar a skill completamente instalada no repositório.
