# Sunfood API

> Esta pasta (`server/`) é a **API e o banco** do Sunfood: servidor, Supabase (migrações e modelos de e-mail) e testes do banco. O **site** fica na raiz deste mesmo repositório. A Vercel publica só esta pasta (Root Directory = `server`) e só refaz o deploy quando algo aqui dentro muda (`ignoreCommand` no `vercel.json`).
>
> Todos os comandos abaixo rodam de dentro da pasta: `cd server`.

Backend real do Sunfood — Node.js + Express, com **Supabase** (Postgres + Auth) como banco de dados e autenticação, **Mercado Pago** para pagamento por PIX e **Stripe** para cartão (hoje em modo de teste). Todas as regras de negócio (pedido mínimo, cancelamento, disponibilidade de item, permissão por papel) são validadas aqui no servidor, nunca só no front-end.

Requer **Node.js 22.5 ou mais recente**.

## Rodando localmente

```bash
npm install
cp .env.example .env
```

Preencha o `.env`:

| Variável | Onde conseguir |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Painel do Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Mesmo lugar — **nunca** exponha essa chave no front-end nem a commite |
| `CORS_ORIGIN` | Endereços do site que podem chamar a API, separados por vírgula (ex.: `https://owdarlley.github.io`) |
| `EMAIL_CONFIRM_REDIRECT_URL` | Para onde o link do e-mail de confirmação de cadastro leva (a tela de login do site, ex.: `https://owdarlley.github.io/sunfood/index.html?login=1`) |
| `PASSWORD_RESET_REDIRECT_URL` | URL pública de `redefinir-senha.html` (ex.: `https://seu-site.github.io/sunfood/redefinir-senha.html`) — precisa também estar na lista de Redirect URLs em Authentication → URL Configuration no Supabase |
| `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` | Painel do Mercado Pago → Suas integrações → Credenciais. Sem isso, o PIX (e o cartão, se o Stripe também não estiver configurado) é aprovado na hora como **provisório** (não cobra dinheiro real) |
| `STRIPE_PUBLISHABLE_KEY` | Mesma página, chave publicável de teste (`pk_test_...`). Com ela, o cartão é digitado na própria tela do app (Payment Element) em vez da página do Stripe |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Dashboard do Stripe → Developers → API keys (use a **chave de teste** `sk_test_...`) e o signing secret (`whsec_...`) do webhook `<API>/payments/stripe/webhook` com os eventos `checkout.session.completed`, `payment_intent.succeeded` e `charge.refunded` (estorno feito no painel do Stripe aparece no app). Com a chave, cartão (crédito ou débito, sempre à vista) e PIX (se o Mercado Pago não estiver configurado) são cobrados pelo Stripe; em modo de teste nada é cobrado (cartão `4242 4242 4242 4242`) |
| `RESEND_API_KEY` (+ opcionais `EMAIL_FROM`, `CONTACT_REPLY_TO`) | resend.com → API Keys (Sending access, domínio sunfood.app.br). Usada para responder o Fale conosco por e-mail. Sem ela, só as respostas por WhatsApp funcionam |

```bash
npm start   # sobe em http://localhost:8787
npm test    # roda os testes (ver abaixo)
```

## Testes

| Onde | O que testa | Como rodar |
| --- | --- | --- |
| `test/*.test.js` | Regras de negócio, permissões por papel, validação, assinatura do webhook e o fluxo completo da API (cadastro → pedido → entregue → excluir conta) com um Supabase falso em memória | `npm test` (roda sozinho no GitHub a cada push) |
| `test/banco/*.sql` | As funções do banco de verdade: CPF do cadastro, estoque, status do pedido, formas de pagamento, prazo de cancelamento, pedido mínimo, quantidade de mesas, categorias do cardápio, número curto do pedido (#001 por dia), painel, encerrar o dia, relatórios, perfil garçom (pedido lançado na mesa, quem entregou e métricas) e estorno pelo painel (estorno parcial fora do faturamento, cancelar em preparo sem devolver estoque) | Colar no SQL Editor do Supabase |

Os `.sql` terminam com um erro **de propósito**: o Postgres desfaz tudo o que fizeram, então nada fica gravado. Passou = a mensagem começa com `TESTE_..._PASSOU`; qualquer `FALHA ...` é um bug.

Os testes das telas ficam no repositório do site (`owdarlley/sunfood`, pasta `tests/fluxo`).

## Banco e e-mails (Supabase)

- `supabase/migrations/`: histórico das mudanças no banco, na ordem em que foram aplicadas no projeto Supabase.
- `supabase/emails/`: modelos dos e-mails de **confirmação de cadastro** e **redefinição de senha**. Para usar, cole o HTML em Authentication → Emails, no painel do Supabase.

## Contas de demonstração

| Perfil | E-mail | Senha |
| --- | --- | --- |
| Cliente | `ana@email.com` | (não publicada) |
| Administração | `admin@sunfood.com` | (não publicada) |
| Cozinha | `cozinha@sunfood.com` | (não publicada) |

Senhas ficam só como hash dentro do Supabase Auth — o backend nunca vê nem guarda a senha em texto puro.

## Endpoints

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| GET | `/health` | — | Responde `{ ok: true }` se a API está no ar |
| POST | `/auth/login` | — | Login via Supabase Auth (limite: 10 tentativas / 15 min por IP) |
| POST | `/auth/signup` | — | Cadastro (a conta sempre nasce como "cliente") |
| POST | `/auth/resend-confirmation` | — | Reenvia o e-mail de confirmação de cadastro |
| POST | `/auth/refresh` | — | Renova a sessão com o refresh token |
| GET | `/auth/me` | qualquer | Dados do usuário logado |
| POST | `/auth/forgot-password` | — | Dispara o e-mail de redefinição de senha |
| POST | `/auth/update-password` | — | Troca a senha usando o token do link do e-mail |
| POST | `/auth/delete-account` | qualquer | Exclui a própria conta (LGPD); os pedidos ficam no histórico sem dono |
| GET | `/products` | — | Cardápio |
| POST | `/products` | admin | Criar produto |
| PUT | `/products/:id` | admin | Editar produto (inclui estoque e foto) |
| POST | `/products/images` | admin | Enviar foto do produto (JPG/PNG/WebP até 2 MB, corpo = o arquivo); devolve `{ url }` pra usar em `imageUrl` |
| PATCH | `/products/:id/sold-out` | admin, cozinha | Sinalizar item (in)disponível |
| GET | `/categories` | — | Categorias do cardápio, na ordem das abas (`name`, `color`, `position`) |
| POST | `/categories` | admin | Criar categoria (`name`, `color` opcional: `mar`, `sol`, `coral`, `uva`, `verde` ou `areia`) |
| PUT | `/categories/:name` | admin | Renomear e/ou trocar a cor (os itens vão junto para o nome novo) |
| POST | `/categories/reorder` | admin | Nova ordem: `{ names: [...] }` com todas as categorias |
| DELETE | `/categories/:name` | admin | Excluir categoria sem itens (com itens, 409) |
| GET | `/tables` | — | Lista de mesas |
| PATCH | `/tables/:number/active` | admin | Ativar/desativar mesa |
| POST | `/orders` | cliente | Criar pedido (pedido mínimo, mesa ativa, estoque, quiosque aberto) |
| POST | `/orders/manual` | garcom, admin | Garçom lança pedido feito na mesa (mesmas regras do app; pago na entrega; fica no nome do garçom) |
| GET | `/orders/mine` | cliente | Pedidos do próprio usuário. Cada um traz `refunds`: valor, motivo, itens e data de cada estorno (sem quem da equipe estornou); cancelamento pelo cliente e pagamento atrasado devolvido também entram |
| GET | `/orders` | admin, cozinha, garcom | Lista de pedidos (`?status=` opcional; o garçom recebe só fila, preparo e prontos) |
| GET | `/orders/:id` | dono ou admin/cozinha | Detalhe de um pedido (para o cliente, com `refunds` como em `/orders/mine`) |
| POST | `/orders/:id/cancel` | cliente (dono) | Cancelar (só "Na Fila" e dentro do prazo); estorna se já foi pago |
| POST | `/orders/:id/refund` | admin | Estorno pelo painel: `{cancel: true, reason}` tira o pedido da cozinha (Na Fila, Em Preparo ou Pronto) e devolve tudo o que falta; `{amount, reason, items?}` devolve só uma parte (em reais) e o pedido continua; `items` (`[{name, qty}]`) são os itens devolvidos, que o cliente vê no pedido (precisa da migração `20261017220000_add_refund_items.sql`; sem ela o estorno é registrado sem os itens). Mesmo meio do pagamento (Stripe ou Mercado Pago). Pedido "na entrega" ou não pago só é cancelado. Precisa da migração `20261017210000_add_order_refunds.sql` |
| GET | `/orders/:id/refunds` | admin | Estornos do pedido: valor, motivo, quem fez e quando (estorno feito no painel do Stripe aparece como "Painel do Stripe") |
| PATCH | `/orders/:id/status` | admin, cozinha, garcom | Avançar status (kanban). O garçom só marca "Entregue"; quem entregou fica gravado no pedido |
| PATCH | `/orders/:id/payment-received` | admin, garcom | Anotar como o garçom recebeu um pedido "pagar na entrega" |
| GET | `/payments/status` | — | Diz quem cobra o PIX e o cartão (`mercadopago`, `stripe` ou `provisorio`) e se o Stripe está em modo de teste |
| POST | `/payments/pix/:orderId` | cliente (dono) | Gera a cobrança PIX no Mercado Pago ou no Stripe (só aprova como provisório se nenhum dos dois estiver configurado) |
| POST | `/payments/card/:orderId` | cliente (dono) | Abre o checkout de cartão do Stripe (ou do Mercado Pago, ou aprova como provisório) |
| POST | `/payments/card-session` | cliente | Sessão do cliente no Stripe antes de existir o pedido: devolve o `customerSessionClientSecret` (cartões salvos, uso só com o cliente presente) e a chave publicável, pra o app desenhar os campos do cartão na hora |
| POST | `/payments/card-intent/:orderId` | cliente (dono) | Pagamento do pedido: devolve o `clientSecret` do PaymentIntent, o valor em centavos (`amount`), a chave publicável e o `customerSessionClientSecret` (com `?session=0`, vem `null`: o app já pegou a sessão em `/card-session`) |
| POST | `/payments/card-holder/:orderId` | cliente (dono) | Titular do cartão (`{name, cpf}`): nome completo e CPF válido, guardados no PaymentIntent antes de confirmar |
| GET | `/payments/pix/:orderId/status` | cliente (dono) | Status do pagamento do pedido |
| POST | `/payments/mercadopago/webhook` | Mercado Pago | Aviso de pagamento: assinatura verificada e status sempre reconferido na API deles |
| POST | `/payments/stripe/webhook` | Stripe | Fim do checkout de cartão: assinatura `Stripe-Signature` verificada e sessão reconferida na API do Stripe antes de liberar o pedido |
| GET | `/kiosk-settings` | — | Estado do quiosque (pausado, dia encerrado, pedido mínimo, prazo de cancelamento) |
| PATCH | `/kiosk-settings/pause` | admin | Pausar/reabrir o quiosque |
| PATCH | `/kiosk-settings/min-order` | admin | Mudar o valor do pedido mínimo (`minOrder`) e/ou ligar e desligar (`enabled`) |
| PATCH | `/kiosk-settings/cancel-window` | admin | Mudar o prazo de cancelamento (0 a 120 min) |
| GET | `/dashboard` | admin | Vendas do dia, por horário e mais vendidos |
| GET | `/reports/sales?period=hoje\|7d\|30d` | admin | Relatórios: vendas, mais vendidos e horários de pico no período (só pedidos pagos ou na entrega, sem cancelados/estornados) |
| GET | `/ops-metrics` | admin | Tempo médio de fila/preparo, atrasos, cancelamentos, itens esgotados |
| GET | `/day-reports/latest` | admin | Último relatório de fechamento do dia |
| POST | `/close-day` | admin | Encerra o dia e grava o relatório |
| POST | `/reopen-day` | admin | Desfaz o encerramento |
| GET | `/waiter/metrics?period=hoje\|7d\|30d` | garcom | Métricas do próprio garçom: pedidos entregues, tempo médio de pronto até entregue, pedidos lançados, valor lançado e recebido |
| GET | `/waiters` | admin | Garçons cadastrados (ativo ou não) e o que cada um fez hoje |
| POST | `/waiters` | admin | Cria a conta de um garçom (nome, e-mail, senha inicial) |
| PATCH | `/waiters/:id` | admin | Desativa (`{ "active": false }`, não entra mais) ou reativa um garçom |
| GET | `/waiters/:id/report?period=hoje\|7d\|30d` | admin | Página do garçom: métricas (atendidos, valor total, ticket médio, entregas, tempo até entregar) e os pedidos que ele lançou ou entregou no período |
| DELETE | `/waiters/:id` | admin | Exclui a conta do garçom. Os pedidos continuam, só perdem o vínculo com ele |
| POST | `/contact` | — | "Fale conosco" do site: grava a mensagem e devolve o protocolo (limite: 5 / 15 min por IP) |
| GET | `/contact` | admin | Mensagens recebidas pelo Fale conosco, mais novas primeiro |
| PATCH | `/contact/:id/status` | admin | Marcar mensagem como respondida (ou nova) |
| POST | `/contact/:id/reply` | admin | Responder: se o contato é e-mail, envia pela Resend; se é telefone, só registra (o app abre o WhatsApp). Marca como respondida |

## Modelo de dados (Supabase Postgres)

`profiles` (papel do usuário: cliente, admin, cozinha ou garcom; ligado a `auth.users`), `products`, `kiosk_tables`, `orders` + `order_items` + `order_status_log`, `kiosk_settings`, `day_reports`, `contact_messages` (Fale conosco). Ver as migrações aplicadas no projeto Supabase para o schema completo, incluindo as funções `create_order`, `set_order_status`, `dashboard_stats`, `ops_metrics`, `sales_report`, `waiter_metrics` e `close_day`, que gravam/agregam atomicamente e só são executáveis pelo `service_role` (nunca direto por um cliente autenticado).

## Segurança

- **Supabase Auth** cuida de senha (hash), sessão (access + refresh token), confirmação de e-mail e recuperação de senha — nada disso é reinventado aqui.
- **Row Level Security** habilitada em toda tabela; a service role (usada só pelo backend) ignora RLS de propósito porque é este servidor que valida as regras de negócio antes de gravar — por isso as policies de escrita direta em `orders`/`order_items` foram removidas: um cliente com o próprio token não consegue criar ou alterar pedido pulando o Express.
- Funções do banco que gravam dados (`create_order`, `set_order_status`, `dashboard_stats`, `ops_metrics`, `sales_report`, `close_day`) são executáveis **só pelo `service_role`** — nem `anon` nem `authenticated` conseguem chamá-las direto pela API REST do Supabase.
- Trigger no banco impede um usuário de trocar o próprio `role` direto pela API (proteção contra auto-escalação de privilégio).
- Validação de entrada com **zod** em todo endpoint que recebe body.
- **express-rate-limit** em login, cadastro, recuperação de senha, criação de pedido e geração de PIX.
- **helmet** + **CORS** restrito a uma lista de origens (`CORS_ORIGIN`, separadas por vírgula).
- Webhook do Mercado Pago com **verificação de assinatura HMAC** e reconsulta do status na API deles antes de liberar qualquer pedido — o corpo da notificação nunca é confiado por si só.
- Webhook do Stripe com **verificação de assinatura** sobre o corpo cru e reconsulta da sessão na API do Stripe. A chave secreta fica só na variável de ambiente do servidor.
- Sem `MERCADOPAGO_ACCESS_TOKEN`, o PIX (e o cartão, sem `STRIPE_SECRET_KEY`) é aprovado como **provisório** (sem cobrança) e aparecem assim na tela de Pagamentos do admin. Configure o token antes de usar com clientes de verdade.

## Deploy (Vercel)

O projeto já está preparado pra rodar como função serverless (`api/index.js` + `vercel.json`). A função roda em `pdx1` (Portland, EUA), perto do banco do Supabase (`us-west-2`, Oregon): cada pedido à API faz 2 ou mais consultas ao banco em sequência, e com a função na região padrão da Vercel (Washington) cada uma atravessava os EUA. Se o banco mudar de região, mude `regions` no `vercel.json` junto. Pra publicar:

1. No painel da Vercel, confirme as variáveis de ambiente do projeto (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PASSWORD_RESET_REDIRECT_URL`, `EMAIL_CONFIRM_REDIRECT_URL`, `CORS_ORIGIN`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`).
2. No painel do Supabase, em Authentication → URL Configuration, adicione a URL de `redefinir-senha.html` publicada na lista de Redirect URLs (senão o link do e-mail de recuperação de senha não funciona).
3. No painel do Mercado Pago, configure a Webhook URL apontando pra `https://<seu-domínio-vercel>/payments/mercadopago/webhook`.
4. Ative "Leaked Password Protection" em Authentication → Providers → Email, no painel do Supabase (recomendado pelo próprio linter de segurança do projeto).

## O que ainda falta pra comercialização plena

- Pagamentos ainda rodam como **provisório** até o `MERCADOPAGO_ACCESS_TOKEN` ser configurado na Vercel.
- Multi-tenant (vários quiosques usando o mesmo sistema, cada um com seus próprios dados) não existe — o sistema é single-tenant por design, conforme decidido.
- Termos de Uso e Política de Privacidade (na raiz do site) são um modelo honesto do que o sistema faz hoje, mas devem passar por um advogado antes do lançamento comercial real.
