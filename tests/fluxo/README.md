# Testes de fluxo

Testam o app de ponta a ponta **sem deixar nada gravado em produção**.

| Arquivo | O que testa | Como rodar |
| --- | --- | --- |
| `telas.mjs` | Páginas do site, fluxo do cliente (login → cardápio → carrinho → mesa → PIX → confirmação), kanban da cozinha e todas as telas do admin | `node fluxo/telas.mjs` |
| `pagamentos.mjs` | Formas de pagamento (PIX, cartão, na entrega), modo provisório sem Mercado Pago, tela de Pagamentos do admin e prazo de cancelamento | `node fluxo/pagamentos.mjs` |
| `senha.mjs` | Esqueci minha senha: pedir o link (por e-mail ou CPF), trocar a senha pela tela `redefinir-senha.html`, link expirado e link que cai na página inicial ou no app | `node fluxo/senha.mjs` |
| `google.mjs` | Entrar com Google: pelo Supabase e direto no Google (id_token trocado no Supabase), volta com o token, tela "Falta pouco" (telefone, CPF, nascimento 18+ e termos), Google cancelado e pedido recusado por cadastro incompleto | `node fluxo/google.mjs` |
| `celular.mjs` | Celular com toque (360 e 390 px): aba Pedido depois de recarregar, Enviar link sem e-mail/CPF, botões da Localização, menu do admin pelo botão Menu (sem arrastar para os lados), tabela de pedidos em cartões e telas sem rolagem lateral | `node fluxo/celular.mjs` |
| `conta.mjs` | Cadastro (com CPF validado), login com e-mail não confirmado (botão Reenviar), pedido mínimo, dia encerrado e excluir conta | `node fluxo/conta.mjs` |

Os testes abrem um Chromium de verdade, mas todas as chamadas para a API são respondidas por `fake-api.mjs`, uma API falsa em memória: nada chega ao servidor nem ao banco.

Para rodar todos, de dentro da pasta `tests`: `npm ci`, `npx playwright install chromium` e `npm test`. Os comandos da tabela rodam um de cada vez (também de dentro de `tests`). Se o `unpkg.com` estiver bloqueado, baixe `react@18.3.1`, `react-dom@18.3.1` e `@babel/standalone@7.29.0` com npm numa pasta e rode com `CDN_DIR=<pasta>`.

Os testes da API e do banco ficam no repositório [`sunfood-backend`](https://github.com/owdarlley/sunfood-backend) (`test/` e `test/banco/`).
