# Configurar o bot Raposito na Vercel

Este guia publica **o bot**. O diretório correto é a raiz do projeto, onde ficam `package.json` e `api/telegram.js`; não escolha `website/` para o deploy do bot. O site estático é separado e pode ser publicado como outro projeto depois.

## Você vai precisar

- Uma conta pessoal gratuita na Vercel (Hobby) e uma conta no GitHub.
- Um bot criado no Telegram com o @BotFather — o token é uma senha.
- Um banco PostgreSQL gratuito no Neon e sua connection string.
- O código do projeto no GitHub, de preferência em um repositório **privado na sua conta pessoal**. Não publique token, código de pareamento, senha do banco ou arquivo `.env.local`.

A Vercel Hobby é para projetos pessoais e não comerciais. Se a tela pedir para mudar de plano ou adicionar pagamento, pare antes de confirmar; não é necessário fazer upgrade para este projeto pessoal. Os limites gratuitos podem mudar e o serviço pode pausar quando uma cota for atingida.

## 1. Coloque o código em um repositório privado

1. Baixe e extraia o ZIP do projeto.
2. No GitHub, crie um repositório **Private** na sua conta pessoal (não numa organização).
3. Envie para esse repositório o conteúdo de `telegram-caixinhas-bot/`, incluindo `package.json`, `package-lock.json`, `api/`, `lib/`, `scripts/` e `tests/`. Pode manter a pasta `website/` dentro do repositório.
4. **Não envie** `node_modules/`, `.env.local`, tokens ou senhas. O `.gitignore` do projeto já ignora `node_modules/` e arquivos `.env*`; o `.env.example` contém apenas nomes de variáveis vazios.

Se já usa Git no computador, dentro da pasta do projeto:

```bash
git init
git add .
git commit -m "Inicia o bot Raposito"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
git push -u origin main
```

Troque `SEU_USUARIO/SEU_REPOSITORIO` pelo endereço do seu repositório. Se o Git disser que o repositório já existe, não repita `git init`; use o repositório que já configurou.

## 2. Importe o repositório na Vercel

1. Entre no dashboard da Vercel e escolha **Add New → Project**.
2. Conecte o GitHub, se solicitado, e importe o repositório privado do Raposito.
3. Dê um nome ao projeto, por exemplo `raposito-financas` (o nome pode já estar ocupado).
4. Em **Root Directory**, escolha a pasta que contém `package.json` e `api/telegram.js`. Se esses itens estiverem na raiz do repositório, deixe `./`.
5. Em **Framework Preset**, escolha **Other** se a Vercel não detectar automaticamente um framework.
6. Este projeto não tem build de front-end. Deixe o **Build Command** sem comando customizado e não preencha um diretório de saída próprio. A Vercel instala as dependências a partir de `package.json` e reconhece as funções em `api/`.
7. Se a tela pedir variáveis de ambiente agora, você pode adicioná-las na etapa seguinte. Faça o primeiro deploy e guarde o domínio `https://...vercel.app` que a Vercel mostrar.

**Atenção à pasta raiz:** escolher `website/` publicaria o site estático, não o bot. Para publicar o site mais tarde, crie outro projeto Vercel e use `website/` como raiz.

## 3. Crie o banco e configure os segredos

No Neon, crie um projeto PostgreSQL e copie a connection string em **Connect**. Trate-a como senha.

Na Vercel, abra o projeto do Raposito, vá a **Settings → Environment Variables** e adicione cada variável abaixo. Selecione **Production**; selecione **Preview** somente se realmente for testar o bot em deployments de preview. Não coloque os valores no GitHub nem os envie em mensagens.

| Nome | Valor |
|---|---|
| `DATABASE_URL` | Connection string PostgreSQL do Neon. |
| `TELEGRAM_BOT_TOKEN` | Token que o @BotFather mostrou ao criar o Raposito. |
| `TELEGRAM_WEBHOOK_SECRET` | Segredo aleatório de 1 a 256 caracteres, usando apenas letras, números, `_` ou `-`. |
| `PAIRING_CODE` | Código forte e de uso único que você vai usar para parear sua conta do Telegram. |
| `PUBLIC_BASE_URL` | Domínio da implantação Vercel, com `https://` e sem `/` no final. Ex.: `https://raposito-financas.vercel.app`. |

Para criar um segredo compatível sem compartilhá-lo, abra um terminal no seu computador e rode:

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

Use um valor para `TELEGRAM_WEBHOOK_SECRET` e outro para `PAIRING_CODE`. Guarde o código de pareamento em local seguro até concluir o primeiro acesso. O token do bot nunca deve entrar no código-fonte.

Se você ainda não tem o domínio Vercel, adicione primeiro as quatro variáveis que já conhece. Depois de obter o domínio, adicione `PUBLIC_BASE_URL` e salve.

## 4. Faça um novo deploy

Alterar variáveis não atualiza deploys antigos. Depois de salvar as cinco variáveis, vá a **Deployments** e use **Redeploy** no deploy de produção mais recente — ou faça um novo commit no GitHub para disparar outro deploy.

Quando o deploy estiver pronto, teste no navegador:

```text
https://SEU_DOMINIO.vercel.app/api/health
```

O resultado esperado contém `"ok":true`, por exemplo `{"ok":true,"service":"telegram-caixinhas-bot"}`. Use o domínio exatamente como aparece na Vercel em `PUBLIC_BASE_URL`, sem barra no final.

## 5. Registre o webhook do Telegram

O projeto já inclui o comando `npm run set-webhook`. Ele precisa rodar uma única vez no seu computador, na pasta raiz do projeto, depois que o deploy e as variáveis estiverem configurados.

1. No computador onde você extraiu o projeto, abra um terminal na pasta que contém `package.json`.
2. Crie ali um arquivo **`.env.local`** com estas três linhas, preenchidas localmente:

```env
TELEGRAM_BOT_TOKEN=COLE_O_TOKEN_DO_BOT_AQUI
TELEGRAM_WEBHOOK_SECRET=USE_O_MESMO_SEGREDO_DA_VERCEL
PUBLIC_BASE_URL=https://SEU_DOMINIO.vercel.app
```

3. Rode:

```bash
npm install
npm run set-webhook
```

O comando configura o endpoint `https://SEU_DOMINIO.vercel.app/api/telegram` e não imprime o token. `.env.local` é ignorado pelo Git; **não o envie ao GitHub**. Apague esse arquivo local depois de confirmar que o webhook foi registrado. Se o endpoint mudar, rode o comando novamente com a URL nova.

## 6. Faça o primeiro pareamento

No Telegram, abra o chat privado do Raposito e envie uma única vez:

```text
/start SEU_PAIRING_CODE
```

Substitua `SEU_PAIRING_CODE` pelo valor configurado em `PAIRING_CODE`. Depois envie:

```text
/configurar
```

O bot pedirá sua renda líquida, o total das contas fixas e quanto você planeja guardar por mês.

## Se algo não funcionar

- **`/api/health` não responde:** confira o domínio e o deploy de produção em Vercel → **Deployments**.
- **Webhook não registra:** confirme que o token é do Raposito, que a URL é HTTPS e que `TELEGRAM_WEBHOOK_SECRET` bate exatamente entre Vercel e `.env.local`.
- **O bot não responde:** abra os logs da Function `/api/telegram` no deploy da Vercel e confira se `DATABASE_URL` e o token foram salvos no ambiente **Production**. Depois de corrigir uma variável, faça redeploy.
- Nunca publique logs, tokens ou connection strings ao pedir ajuda.

## Referências oficiais

- [Importar um repositório Git na Vercel](https://vercel.com/docs/git)
- [Configurar uma build e o diretório raiz](https://vercel.com/docs/builds/configure-a-build)
- [Gerenciar variáveis de ambiente](https://vercel.com/docs/environment-variables/managing-environment-variables)
- [Plano Vercel Hobby](https://vercel.com/docs/plans/hobby)
- [Planos do Neon](https://neon.com/docs/introduction/plans)
- [Telegram Bot API](https://core.telegram.org/bots/api)
