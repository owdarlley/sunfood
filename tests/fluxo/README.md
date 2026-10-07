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
| `localizacao.mjs` | Localização do quiosque: o admin muda nome, endereço e horário em "Quiosque e mesas" e o cliente vê na tela Localização, com o mapa e o "Abrir no mapa" do Google Maps saindo do endereço (celular, tablet e computador) | `node fluxo/localizacao.mjs` |
| `sessao.mjs` | Sessão que não cai sozinha: token vencido é renovado com o refreshToken (antes de chamar a API e ao receber 401), cozinha/admin seguem atualizando, sessão encerrada de vez volta ao login com aviso, e quem já entrou não abre na tela de login | `node fluxo/sessao.mjs` |
| `excluir-produto.mjs` | Excluir item do cardápio: botão Excluir em "Cardápio e estoque", confirmação (Cancelar não apaga nada), item some da lista e cabe na tela no celular, tablet e computador | `node fluxo/excluir-produto.mjs` |
| `relatorios.mjs` | Exportar relatórios do admin: planilha `.csv` (abre no Excel, com `;` e vírgula decimal) e versão para imprimir/salvar como PDF, do período escolhido (hoje, 7 ou 30 dias), com a lista de pedidos no horário de São Paulo (celular, tablet e computador) | `node fluxo/relatorios.mjs` |
| `desempenho.mjs` | Recarregar sem tremer e toque rápido: a página é baixada uma vez só, a primeira visita mostra cartões vazios até o cardápio chegar (sem itens de exemplo trocados na frente), ao recarregar o cardápio guardado aparece na hora sem nada sair do lugar, e a cozinha vê o pedido mudar de coluna no toque, antes do servidor responder (celular, tablet e computador) | `node fluxo/desempenho.mjs` |
| `mesas.mjs` | Quantidade de mesas: o admin escolhe quantas mesas existem (celular, tablet e computador) e o cliente só consegue pedir de 1 até esse número | `node fluxo/mesas.mjs` |
| `responder-mensagens.mjs` | Responder o Fale conosco pela tela Mensagens do admin: contato com e-mail recebe a resposta por e-mail (com aviso se o envio não estiver configurado no servidor), contato com telefone abre o WhatsApp com o texto pronto, e a resposta fica salva no cartão em Respondidas (celular, tablet e computador) | `node fluxo/responder-mensagens.mjs` |

Os testes abrem um Chromium de verdade, mas todas as chamadas para a API são respondidas por `fake-api.mjs`, uma API falsa em memória: nada chega ao servidor nem ao banco.

Para rodar todos, de dentro da pasta `tests`: `npm ci`, `npx playwright install chromium` e `npm test`. Os comandos da tabela rodam um de cada vez (também de dentro de `tests`). Se o `unpkg.com` estiver bloqueado, baixe `react@18.3.1`, `react-dom@18.3.1` e `@babel/standalone@7.29.0` com npm numa pasta e rode com `CDN_DIR=<pasta>`.

Os testes da API e do banco ficam no repositório [`sunfood-backend`](https://github.com/owdarlley/sunfood-backend) (`test/` e `test/banco/`).
