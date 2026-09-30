# Site Caixinhas

Site estático, em português, para apresentar o bot pessoal de orçamento no Telegram. Não contém backend, não coleta valores financeiros e não inclui tokens. O bot continua precisando de configuração antes de ser usado.

## Visualização local

Abra `index.html` diretamente no navegador ou inicie um servidor local dentro desta pasta:

```bash
python3 -m http.server 8000
```

Depois abra `http://localhost:8000`.

## Hospedagem futura

Esta versão não foi publicada. Como é somente HTML, CSS e JavaScript estático, pode ser hospedada em qualquer plano de site estático. Para Vercel, selecione `website/` como diretório raiz e não configure build command nem backend para o site. O bot é um projeto separado na pasta pai.

Antes de usar um domínio público, atualize as URLs de canonical e Open Graph (incluindo `og:url` e `og:image`) com o domínio real. Não use URL inventada ou interna. A página já tem title, description e tags Open Graph sem endereço fictício.

## Arquivos

- `index.html` — conteúdo e estrutura semântica.
- `styles.css` — estilos responsivos, cores e mockups em CSS.
- `script.js` — menu móvel, botões de copiar e atualização do ano.
- `favicon.svg` — símbolo vetorial próprio.
- `ideas.md` — direção visual escolhida.
