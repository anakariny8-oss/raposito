# Bot pessoal de orçamento e caixinhas no Telegram

Bot privado para uma única pessoa. Registra despesas, acompanha um teto mensal, controla limites por categoria e calcula o ritmo de economia para objetivos como uma viagem. O bot **não** acessa bancos, não movimenta dinheiro e não usa um modelo de IA pago: a leitura de mensagens e os cálculos são feitos por regras simples.

## O que já está implementado

- Pareamento de um único usuário por código secreto; depois disso, outras contas são recusadas.
- Webhook HTTPS protegido pelo cabeçalho secreto oficial do Telegram.
- Configuração mensal perguntando renda líquida, total de contas fixas e quanto se pretende guardar.
- Teto de gastos mensal = renda líquida menos o valor planejado para guardar. As contas fixas são colocadas na caixinha `contas`.
- Caixinhas iniciais sugeridas: mercado 40%, transporte 15%, lazer 20%, viagem 15% e outros 10% do valor variável. São apenas um ponto de partida; podem ser ajustadas e nunca podem somar mais que o teto mensal.
- Registro por comando ou mensagem, por exemplo `gastei R$ 50 no almoço`.
- Saldo total, restante por caixinha, metas com prazo e registro manual de quanto foi guardado.
- Novo orçamento mensal copia automaticamente as regras do mês anterior; os lançamentos permanecem associados ao mês em que ocorreram.
- `/apagardados` solicita confirmação explícita antes de apagar os registros. `/desfazer` remove o lançamento mais recente.
- O sistema não guarda o texto bruto do webhook nem registra dados de banco; guarda somente orçamento, valor, categoria, descrição curta e data.

## Comandos

- `/configurar` — inicia o orçamento com renda, contas fixas e valor planejado para guardar.
- `/limite 2500` — define manualmente o teto total de gastos do mês.
- `gastei R$ 50 no mercado` ou `/gastei 50 mercado almoço` — registra uma despesa.
- `/saldo` — mostra teto, total gasto e saldo do mês.
- `/caixinhas` — mostra limites e saldos das categorias.
- `/caixinha mercado 800` — define ou ajusta uma caixinha; o bot impede que a soma passe do teto.
- `/meta São Paulo 1200 2026-12-20` — cria ou atualiza um objetivo com valor e prazo.
- `/guardar 100 São Paulo` — registra uma contribuição informada pelo usuário; não transfere dinheiro.
- `/metas` — mostra progresso e uma estimativa mensal até cada prazo.
- `/desfazer` — apaga o último gasto registrado.
- `/apagardados` — inicia confirmação em duas etapas para apagar dados.
- `/ajuda` — mostra a lista de comandos.

## Custos e limites

- Telegram afirma que suas APIs para desenvolvedores, incluindo a Bot API, podem ser usadas gratuitamente. O recurso de transmissões pagas do Telegram é para volume acima de 30 mensagens por segundo; este bot responde a uma conversa privada e não usa transmissões.
- Vercel Hobby é gratuito para projetos pessoais e não comerciais. Tem cotas; ao ultrapassá-las, o serviço pode ficar indisponível até a cota voltar, em vez de cobrar automaticamente.
- Neon Free não tem mensalidade. O banco pode suspender a computação ao esgotar cotas; os dados não são apagados por isso.
- Para manter o projeto sem cobrança, use somente os planos gratuitos e **não adicione método de pagamento**. Cotas e regras de serviços gratuitos podem mudar. Ao atingir limites, o bot pode parar temporariamente.

Fontes: [Telegram Bot API](https://core.telegram.org/bots/api), [Telegram APIs](https://botfather.telegram.org/), [Vercel Hobby](https://vercel.com/docs/plans/hobby), [planos Neon](https://neon.com/docs/introduction/plans).

## Implantação resumida

Você precisará de contas gratuitas na Vercel e Neon e de um bot criado pelo `@BotFather`. O token do Telegram é uma senha: não o envie por mensagem nem o coloque no código.

1. Crie um bot no Telegram conversando com [@BotFather](https://t.me/BotFather), usando `/newbot`. Guarde o token em local seguro.
2. Crie um banco Postgres no [Neon](https://neon.tech/). Copie a connection string (`DATABASE_URL`) e mantenha-a privada.
3. Publique este projeto numa conta **Vercel Hobby pessoal** (importando o repositório ou com a Vercel CLI). A função webhook ficará em `/api/telegram`.
4. Nas variáveis de ambiente de produção da Vercel, configure:
   - `DATABASE_URL` — connection string do Neon;
   - `TELEGRAM_BOT_TOKEN` — token do BotFather;
   - `TELEGRAM_WEBHOOK_SECRET` — segredo aleatório com letras, números, `_` ou `-`;
   - `PAIRING_CODE` — código forte, de uso único, para vincular sua conta;
   - `PUBLIC_BASE_URL` — URL HTTPS da implantação Vercel, sem barra final.
5. Depois do deploy, configure o webhook do Telegram para `https://SEU-PROJETO.vercel.app/api/telegram`, usando o valor de `TELEGRAM_WEBHOOK_SECRET` como `secret_token`.

### Registro do webhook sem pôr o token no código

Este projeto inclui `npm run set-webhook`. Para executá-lo localmente, crie um arquivo `.env.local` não versionado com `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` e `PUBLIC_BASE_URL`; execute o comando e apague o arquivo local ao terminar. `.env.local` já está no `.gitignore`. Não coloque esse arquivo em repositórios ou pastas compartilhadas.

### Primeiro acesso

Abra o bot e envie `/start SEU_CODIGO_DE_PAREAMENTO` uma única vez. A primeira conta pareada se torna a única autorizada. Depois, envie `/configurar`.

## Observações de segurança e escopo

- Não envie senhas de banco, número completo de cartão, códigos de autenticação ou extratos ao bot.
- O bot registra somente informações necessárias ao orçamento. Ainda assim, os valores ficam armazenados no banco da conta Neon e as mensagens ficam no seu chat do Telegram.
- O bot não faz recomendações de investimento, não movimenta dinheiro e não substitui aconselhamento profissional; suas sugestões de percentuais são editáveis.
- A implantação ainda requer que a proprietária crie o bot no BotFather e configure as variáveis e serviços descritos acima. Nenhuma conta externa foi conectada por este pacote.

## Testes

```bash
npm install
npm test
```
