# Sunfood

Sistema de pedidos online para quiosques de praia.

O site resolve a dor de quiosques com alta rotatividade de clientes e atendimento disperso entre mesas e guarda-sóis: hoje o processo é quase todo em papel. O Sunfood propõe cardápio digital, pedido pelo celular, pagamento real via PIX, conta dividida sem cálculo manual e acompanhamento em tempo real para cozinha e administração.

**O front-end é estático** (publicado no GitHub Pages) **e fala com um backend real** — Node/Express + Supabase (Postgres + Auth), com autenticação, banco de dados e as regras de negócio validadas no servidor (não só no navegador), mais Mercado Pago para pagamento PIX de verdade. Veja [`server/README.md`](server/README.md) para detalhes e para rodar a API localmente.

## 🔗 Acesse pelo GitHub Pages

**https://owdarlley.github.io/sunfood/**

O site é publicado direto da branch `main` deste repositório — qualquer alteração enviada para `main` atualiza automaticamente o endereço acima em poucos minutos.

O front-end detecta sozinho onde está rodando: em `localhost`, fala com a API local (`http://localhost:8787`); publicado (GitHub Pages ou qualquer outro domínio), fala com a API de produção. Se a API de produção estiver fora do ar ou sem as credenciais configuradas (ver `server/README.md`), o botão **Entrar** mostra "Falha de conexão com o servidor" — as páginas de conteúdo (Sobre, Funcionalidades, etc.) continuam funcionando normalmente.

**Contas de demonstração** (botão **Entrar** no menu, abre o modal de login em `index.html`):

| Perfil | E-mail | Senha | Abre |
| --- | --- | --- | --- |
| Cliente | `ana@email.com` | `praia2026` | cardápio da mesa |
| Administração | `admin@sunfood.com` | `admin2026` | dashboard de vendas |
| Cozinha | `cozinha@sunfood.com` | `cozinha2026` | kanban de pedidos |

## Como navegar

A home (`index.html`) traz o menu principal, de onde se chega a todas as páginas do site:

| Página | Arquivo | Conteúdo |
| --- | --- | --- |
| Início | `index.html` | Chamada principal, prévia do app do cliente e índice das demais páginas |
| Funcionalidades | `funcionalidades.html` | Benefícios do sistema para o quiosque |
| Como funciona | `como-funciona.html` | O fluxo em três passos, do guarda-sol à cozinha |
| Perfis de acesso | `perfis.html` | O que cliente, cozinha e administração enxergam |
| Protótipo completo | `prototipo.html` | Protótipo navegável de 38 telas (Cliente, Administração, Cozinha) |
| Sobre nós | `sobre.html` | Missão, visão, contexto e problema do projeto |
| Fale conosco | `contato.html` | Formulário de contato e pré-agendamento |
| Mapa do sistema | `mapa.html` | Mapa completo de páginas e telas, para fins de documentação |
| Termos de Uso | `termos.html` | Termos de uso do sistema |
| Política de Privacidade | `privacidade.html` | Tratamento de dados pessoais, conforme a LGPD |
| Redefinir senha | `redefinir-senha.html` | Segunda etapa do "esqueci minha senha" (o link do e-mail cai aqui) |

O botão **Entrar**, no menu fixo de todas as páginas, abre o login (direto na home, ou via `index.html?login=1` a partir de qualquer outra página) — com links reais para cadastro e recuperação de senha. Login correto identifica o perfil e leva ao módulo certo de `app-cliente.dc.html` (cliente, administração ou cozinha); login incorreto mostra "Credenciais inválidas". `prototipo-completo.html` e `support.js` são arquivos de apoio carregados pelas páginas acima.

## Rodando localmente

O front-end continua estático (nenhum build, nenhuma dependência) — mas pra login/cardápio/pedido funcionarem, a API precisa estar rodando também. Dois terminais:

```bash
# terminal 1 — API (porta 8787) — veja server/README.md para o .env
cd server
npm install
npm start

# terminal 2 — front-end (porta 8000)
python3 -m http.server 8000
```

Acesse `http://localhost:8000`.

## Estrutura de pastas

```
index.html, sobre.html, contato.html, ...    → páginas do site
termos.html, privacidade.html                → documentos legais
redefinir-senha.html                         → segunda etapa da recuperação de senha
app-cliente.dc.html, prototipo-completo.html → protótipos navegáveis (fala com a API)
support.js                                   → script de apoio às páginas
assets/                                      → imagens usadas no projeto
server/                                      → backend Node/Express + Supabase + Mercado Pago (ver server/README.md)
```

## Grupo

Dárlley Alves de Almeida — RGM 42298415 — darlley1997@gmail.com
Docente: Cristiano S. Negrão — Análise e Projeto de Sistemas II
