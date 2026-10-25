# SunFood

Sistema de pedidos online para quiosques de praia.

O site resolve a dor de quiosques com alta rotatividade de clientes e atendimento disperso entre mesas e guarda-sóis: hoje o processo é quase todo em papel. O SunFood propõe cardápio digital, pedido pelo celular, pagamento por PIX, cartão ou na entrega, e acompanhamento em tempo real para cozinha e administração.

> **Tudo do SunFood fica neste repositório.** Na raiz está o **site** (as páginas e o app que o cliente, a cozinha e o admin usam, publicado pelo GitHub Pages). A **API e o banco** (servidor, Supabase, migrações, modelos de e-mail) ficam na pasta [`server/`](server/README.md), publicada pela Vercel.

## Tecnologias

- **Site e app**: HTML, CSS e React 18 sem build (carregado do unpkg), instalável como PWA e empacotado como app Android (TWA). Endereço: https://sunfood.app.br/
- **API**: Node.js 22 + Express, publicada na Vercel (pasta [`server/`](server/README.md)).
- **Banco e login**: Supabase (Postgres + Auth), com as regras de negócio em funções do banco.
- **Pagamentos**: Stripe (PIX e cartão, hoje em modo de teste); e-mails pelo Resend.
- **Testes**: Playwright nas telas, `node --test` na API e um Postgres de verdade no CI para as funções do banco.

## 🔗 Acesse

**https://sunfood.app.br/**

- **Ambiente**: produção, usada como demonstração acadêmica. O banco e os e-mails são reais; os pagamentos (Stripe) estão em modo de teste, então nada é cobrado.
- **Domínio**: `sunfood.app.br`, registrado no registro.br. O DNS aponta para o GitHub Pages (registros A/AAAA na raiz e `www` como CNAME para `owdarlley.github.io`), com HTTPS obrigatório. O endereço antigo https://owdarlley.github.io/sunfood/ redireciona para o domínio.
- **API**: https://sunfood-api-nine.vercel.app (teste rápido: `/health` responde `{"ok":true}`).
- **Limitações**: o Supabase gratuito pausa o projeto depois de cerca de 7 dias sem uso (reativar no painel); a Vercel gratuita tem limites mensais e a primeira chamada depois de um tempo parada pode levar alguns segundos; o domínio precisa ser renovado todo ano no registro.br.

O site é publicado direto da branch `main` deste repositório — qualquer alteração enviada para `main` atualiza automaticamente o endereço acima em poucos minutos.

O front-end detecta sozinho onde está rodando: em `localhost`, fala com a API local (`http://localhost:8787`); publicado (GitHub Pages ou qualquer outro domínio), fala com a API de produção. Se a API de produção estiver fora do ar, o botão **Entrar** mostra "Falha de conexão com o servidor" — as páginas de conteúdo (Sobre, Funcionalidades, etc.) continuam funcionando normalmente.

**Contas**: o site fala com o banco de produção, então nenhuma senha fica publicada aqui. Para testar como cliente, crie uma conta pelo próprio site (Criar conta) ou peça a conta de demonstração ao responsável pelo projeto. As contas de **Administração** (abre o dashboard de vendas) e **Cozinha** (abre o kanban de pedidos) também são pedidas ao responsável: quem tem essas senhas consegue mudar preços, pausar o quiosque e encerrar o dia de verdade.

O **Garçom** (abre "Para entregar": pedidos prontos para levar, lançar pedido feito na mesa e as próprias métricas) também não tem senha publicada: cada garçom recebe a conta do admin, na tela **Garçons** do painel.

## Como navegar

O endereço principal (`index.html`, ou seja, https://sunfood.app.br/) é a **tela de login** do sistema. Não há site institucional separado: os links do rodapé do login abrem o conteúdo num painel por cima da própria tela, cada um com endereço próprio:

| Link do rodapé | Endereço | Conteúdo |
| --- | --- | --- |
| Conheça o SunFood | `/#conheca` | Proposta, benefícios, como funciona, os quatro perfis e sobre o projeto |
| Fale conosco | `/#fale-conosco` | Formulário de contato (grava pela API, `POST /contact`) |
| Termos de uso | `/#termos` | Termos de uso do sistema |
| Privacidade | `/#privacidade` | Política de privacidade, conforme a LGPD |
| Baixe o app | `/#baixar-app` | Download do app Android (APK assinado em `download/sunfood.apk`), passo a passo da instalação e QR Code para abrir no celular. Some dentro do próprio app |

Os endereços antigos (`inicio.html`, `sobre.html`, `funcionalidades.html`, `como-funciona.html`, `perfis.html`, `mapa.html`, `contato.html`, `termos.html`, `privacidade.html`) continuam funcionando e redirecionam para o painel certo. Outras páginas:

| Página | Arquivo | Conteúdo |
| --- | --- | --- |
| Redefinir senha | `redefinir-senha.html` | Segunda etapa do "esqueci minha senha" (o link do e-mail cai aqui) |
| Protótipo (antigo) | `prototipo.html` | Endereço antigo do protótipo; só redireciona para `/#conheca`. O protótipo navegável foi retirado do sistema |

Quem já entrou naquele aparelho vai direto para o seu módulo (exceto quando abre um dos painéis acima). Login correto identifica o perfil e leva ao módulo certo de `app-cliente.dc.html` (cliente, administração, cozinha ou garçom).

## Rodando localmente

O site não tem build nem dependências: basta servir a pasta. Para login, cardápio e pedidos funcionarem, a API precisa estar rodando em `http://localhost:8787` (veja o [README da pasta `server`](server/README.md)).

```bash
python3 -m http.server 8000
```

Acesse `http://localhost:8000`.

## Testes

Os testes de tela ficam em [`tests/fluxo`](tests/fluxo/README.md) e rodam sozinhos no GitHub a cada push. Para rodar na sua máquina:

```bash
cd tests
npm ci
npx playwright install chromium
npm test
```

## App instalável (PWA)

O site pode ser instalado como app. No Chrome ou Edge do computador, aparece o ícone **Instalar** na barra de endereço; no Android, o menu ⋮ mostra **Instalar app**; no iPhone (Safari), use Compartilhar → **Adicionar à Tela de Início**.

O `sw.js` guarda as páginas e arquivos do site para abrirem mais rápido e mostra um aviso quando não há internet. Ele **nunca** guarda chamadas da API, do Supabase ou de pagamento. Páginas e scripts vêm sempre da rede primeiro, então atualizações aparecem na hora. Ao mudar a lista de arquivos ou a lógica do `sw.js`, aumente a constante `VERSAO` no topo dele.

## Estrutura de pastas

```
index.html                 → login + painéis Conheça, Fale conosco, Termos, Privacidade e Baixe o app
app-cliente.dc.html        → o app (cliente, cozinha, garçom e administração), fala com a API
redefinir-senha.html       → segunda etapa da recuperação de senha
offline.html               → aviso de sem internet (PWA)
inicio.html, sobre.html, … → endereços antigos (inclui prototipo.html), só redirecionam para o painel certo
manifest.json, sw.js       → app instalável (PWA); o sw.js fica na raiz para controlar o site inteiro
js/                        → scripts do site
  abertura.js              →   animação de abertura do app
  caber.js                 →   escala da tela de login/cadastro para caber sem rolagem
  celular.js               →   app Android/instalado: sem zoom de pinça, corrige "site para computador"
  pwa.js                   →   registra o service worker e esconde "Baixe o app" dentro do app
  support.js               →   runtime das páginas (gerado, não editar)
icons/                     → ícones e imagens (favicon, app instalado, QR Code, logo dos e-mails)
download/sunfood.apk       → APK assinado do app Android (link "Baixe o app")
android/                   → app Android (TWA) que abre o site; o APK sai pelo GitHub Actions
.well-known/assetlinks.json→ liga o app Android ao domínio sunfood.app.br
server/                    → a API (Node/Express) e o banco (Supabase), publicada pela Vercel
tests/                     → testes de tela (Playwright)
.github/                   → testes automáticos (CI), build do APK e Dependabot
```

O GitHub Pages publica só as páginas: `server/`, `tests/`, `android/` e este README ficam fora do site (veja `_config.yml`).

Os ícones ficam com o mesmo endereço de sempre porque os e-mails e o registro BIMI do domínio apontam para eles; as páginas antigas continuam na raiz pelo mesmo motivo (links salvos).

## Como contribuir

Cada mudança entra por pull request, com os testes do CI verdes, e o merge é feito com **squash**: o PR vira um único commit na `main`, com mensagem que diz o que mudou.

## Grupo

Dárlley Alves de Almeida — RGM 42298415 — darlley1997@gmail.com
Docente: Cristiano S. Negrão — Análise e Projeto de Sistemas II
