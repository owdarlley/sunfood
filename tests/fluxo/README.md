# Testes de fluxo

Testam o app de ponta a ponta **sem deixar nada gravado em produção**.

| Arquivo | O que testa | Como rodar |
| --- | --- | --- |
| `telas.mjs` | Páginas do site, fluxo do cliente (login → cardápio → carrinho → mesa → PIX → confirmação), kanban da cozinha e todas as telas do admin | `node tests/fluxo/telas.mjs` |
| `pagamentos.mjs` | Formas de pagamento (PIX, cartão, na entrega), modo provisório sem Mercado Pago, tela de Pagamentos do admin e prazo de cancelamento | `node tests/fluxo/pagamentos.mjs` |
| `senha.mjs` | Esqueci minha senha: pedir o link, trocar a senha pela tela `redefinir-senha.html`, link expirado e link que cai na página inicial ou no app | `node tests/fluxo/senha.mjs` |
| `google.mjs` | Entrar com Google: ida ao Supabase, volta com o token, tela "Falta pouco" (telefone, nascimento 18+ e termos), Google cancelado e pedido recusado por cadastro incompleto | `node tests/fluxo/google.mjs` |
| `conta.mjs` | Cadastro, login com e-mail não confirmado (botão Reenviar), pedido mínimo, dia encerrado e excluir conta | `node tests/fluxo/conta.mjs` |
| `banco.sql` | No Supabase: pedido baixa estoque, cancelar devolve, transições de status da cozinha, venda acima do estoque recusada | Colar no SQL Editor do Supabase (ou `execute_sql`) |
| `banco-pagamentos.sql` | No Supabase: formas de pagamento e prazo de cancelamento | Idem |
| `banco-conta.sql` | No Supabase: excluir conta mantém pedidos sem dono, pedido mínimo, painel e encerrar o dia | Idem |

Os testes de tela abrem um Chromium de verdade, mas todas as chamadas para a API são respondidas por `fake-api.mjs`, uma API falsa em memória: nada chega ao servidor nem ao banco. Precisam do pacote `playwright` (`npm i -D playwright` numa pasta de rascunho, ou o já instalado no ambiente). Se o `unpkg.com` estiver bloqueado, baixe `react@18.3.1`, `react-dom@18.3.1` e `@babel/standalone@7.29.0` com npm numa pasta e rode com `CDN_DIR=<pasta>`.

Os scripts `.sql` terminam com um erro **de propósito**: o Postgres desfaz tudo o que fizeram. Passou = a mensagem começa com `TESTE_..._PASSOU`. Qualquer mensagem `FALHA ...` é um bug.

Os testes do servidor continuam em `server/` (`npm ci && npm test`). O `test/fluxo-api.test.js` roda a API de verdade do cadastro ao pedido entregue (e excluir conta) com um Supabase falso em memória.
