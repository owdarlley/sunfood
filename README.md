# Sunfood

Sistema de pedidos online para quiosques de praia.

O site resolve a dor de quiosques com alta rotatividade de clientes e atendimento disperso entre mesas e guarda-sóis: hoje o processo é quase todo em papel. O Sunfood propõe cardápio digital, pedido pelo celular, pagamento por PIX, cartão ou na entrega, e acompanhamento em tempo real para cozinha e administração.

> **O Sunfood tem dois repositórios.** Este (`sunfood`) é o **site**: as páginas e o app que o cliente, a cozinha e o admin usam. A **API e o banco** (servidor, Supabase, migrações, modelos de e-mail) ficam em [`owdarlley/sunfood-backend`](https://github.com/owdarlley/sunfood-backend).

## 🔗 Acesse pelo GitHub Pages

**https://owdarlley.github.io/sunfood/**

O site é publicado direto da branch `main` deste repositório — qualquer alteração enviada para `main` atualiza automaticamente o endereço acima em poucos minutos.

O front-end detecta sozinho onde está rodando: em `localhost`, fala com a API local (`http://localhost:8787`); publicado (GitHub Pages ou qualquer outro domínio), fala com a API de produção. Se a API de produção estiver fora do ar, o botão **Entrar** mostra "Falha de conexão com o servidor" — as páginas de conteúdo (Sobre, Funcionalidades, etc.) continuam funcionando normalmente.

**Conta de demonstração** (botão **Entrar** no menu, abre o modal de login em `index.html`):

| Perfil | E-mail | Senha | Abre |
| --- | --- | --- | --- |
| Cliente | `ana@email.com` | `praia2026` | cardápio da mesa |

As contas de **Administração** (`admin@sunfood.com`, abre o dashboard de vendas) e **Cozinha** (`cozinha@sunfood.com`, abre o kanban de pedidos) não têm a senha publicada: quem tem essas senhas consegue mudar preços, pausar o quiosque e encerrar o dia de verdade, já que o site fala com o banco de produção. Peça a senha ao responsável pelo projeto.

## Como navegar

A home (`index.html`) traz o menu principal, de onde se chega a todas as páginas do site:

| Página | Arquivo | Conteúdo |
| --- | --- | --- |
| Início | `index.html` | Chamada principal, prévia do app do cliente e índice das demais páginas |
| Funcionalidades | `funcionalidades.html` | Benefícios do sistema para o quiosque |
| Como funciona | `como-funciona.html` | O fluxo em três passos, do guarda-sol à cozinha |
| Perfis de acesso | `perfis.html` | O que cliente, cozinha e administração enxergam |
| Protótipo | `prototipo.html` | Protótipo navegável de 38 telas (Cliente, Administração, Cozinha) |
| Sobre nós | `sobre.html` | Missão, visão, contexto e problema do projeto |
| Fale conosco | `contato.html` | Formulário de contato e pré-agendamento |
| Mapa do sistema | `mapa.html` | Mapa completo de páginas e telas, para fins de documentação |
| Termos de Uso | `termos.html` | Termos de uso do sistema |
| Política de Privacidade | `privacidade.html` | Tratamento de dados pessoais, conforme a LGPD |
| Redefinir senha | `redefinir-senha.html` | Segunda etapa do "esqueci minha senha" (o link do e-mail cai aqui) |

O botão **Entrar**, no menu fixo de todas as páginas, abre o login (direto na home, ou via `index.html?login=1` a partir de qualquer outra página) — com links reais para cadastro e recuperação de senha. Login correto identifica o perfil e leva ao módulo certo de `app-cliente.dc.html` (cliente, administração ou cozinha); login incorreto mostra "Credenciais inválidas". `prototipo-completo.html` e `support.js` são arquivos de apoio carregados pelas páginas acima.

## Rodando localmente

O site não tem build nem dependências: basta servir a pasta. Para login, cardápio e pedidos funcionarem, a API precisa estar rodando em `http://localhost:8787` (veja o README do [`sunfood-backend`](https://github.com/owdarlley/sunfood-backend)).

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
index.html, sobre.html, contato.html, ...    → páginas do site
termos.html, privacidade.html                → documentos legais
redefinir-senha.html                         → segunda etapa da recuperação de senha
app-cliente.dc.html                          → o app (cliente, cozinha e administração), fala com a API
prototipo.html, prototipo-completo.html      → protótipo navegável das telas
support.js                                   → script de apoio às páginas (gerado, não editar)
assets/                                      → imagens usadas no protótipo
manifest.json, sw.js, pwa.js, offline.html   → app instalável (PWA): manifesto, service worker, registro e aviso sem internet
icons/                                       → ícones do app instalado (192, 512, maskable, iPhone, favicon)
tests/                                       → testes de tela (Playwright)
```

## Grupo

Dárlley Alves de Almeida — RGM 42298415 — darlley1997@gmail.com
Docente: Cristiano S. Negrão — Análise e Projeto de Sistemas II
