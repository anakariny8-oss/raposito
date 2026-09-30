# Direção visual — site Caixinhas

## Direções consideradas

- **Caderno Calmo** — Um caderno financeiro editorial traduzido em uma interface digital leve, com fundo papel, verde-pinho e pequenos acentos de coral. Probabilidade: 0.06.
- **Caixa Viva** — Uma linguagem mais lúdica, com blocos de cor forte e envelopes que parecem peças físicas empilhadas. Probabilidade: 0.03.
- **Saldo Digital** — Um painel contemporâneo de alto contraste, com azul elétrico, grafite e códigos visuais de dados. Probabilidade: 0.08.

## Direção escolhida: Caderno Calmo

### Movimento de design
Editorial financeiro acolhedor: a disciplina de um caderno de orçamento encontra a clareza de um produto digital contemporâneo.

### Princípios centrais
Clareza antes de persuasão; dinheiro explicado sem julgamento; exemplos legíveis; cada valor importante acompanhado de contexto; hierarquia generosa e conteúdo acessível por teclado.

### Filosofia de cor
Papel marfim como superfície principal (`#F7F4EC`), verde-pinho como cor de confiança (`#153E35`), verde-sálvia para dados positivos (`#CFE0D5`), coral suave para ações e destaques (`#E77B5C`) e tinta carvão para texto (`#242824`). Evitar gradientes brilhantes e vermelho de alerta como recurso decorativo.

### Paradigma de layout
Página editorial de uma coluna principal, alternando texto e cartões demonstrativos. A primeira dobra combina promessa e mockup de conversa; em telas pequenas o mockup vem depois do texto. Seções curtas, âncoras claras e uma faixa de comandos fácil de consultar.

### Elementos de assinatura
Mockup de conversa com mensagens curtas, uma caixa de resumo do mês e envelopes com trilhas de progresso; filetes e pequenos rótulos lembram anotações de um caderno. Os valores do mockup são explicitamente exemplos ilustrativos.

### Filosofia de interação
Sem animações necessárias para compreender conteúdo. Links de âncora, foco visível, contraste adequado, menu simples e um botão de copiar comandos com fallback textual; sem popups ou formulário que peça dados financeiros.

### Animação
Preferir transições discretas em hover/foco; respeitar `prefers-reduced-motion`. Nenhuma animação deve ocultar informação ou ser indispensável para navegação.

### Sistema tipográfico
Títulos com serif editorial de fallback seguro (`Georgia`, `Times New Roman`); corpo com `system-ui`. Tamanhos fluídos via `clamp()`, altura de linha confortável e números tabulares quando disponíveis.

### Essência e voz da marca
Uma ajudante prática, gentil e sem culpa: “organizar dá mais clareza, não mais cobrança”. Texto direto e brasileiro, evitando promessas de economia garantida ou aconselhamento financeiro profissional.

### Wordmark e marca
Wordmark simples “caixinhas” em minúsculas. Símbolo original desenhado em SVG inline: três pequenos compartimentos em uma forma de caderno/envelope. A marca Telegram aparece somente como contexto do canal, não como identidade do produto.

### Cor de assinatura
Verde-pinho `#153E35`.

### Uso de assets
Foi feita busca por imagens do logo do Telegram. Os resultados eram majoritariamente assets de bancos de imagem ou sem licença de reutilização clara; não serão incorporados. O visual principal será um mockup HTML/CSS original do bot, sem imagem de stock ou dependência de serviços externos.
