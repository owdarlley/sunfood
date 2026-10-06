# Sunfood

Sistema de pedidos online para quiosques de praia.

O site resolve a dor de quiosques com alta rotatividade de clientes e atendimento disperso entre mesas e guarda-sóis: hoje o processo é quase todo em papel. O Sunfood propõe cardápio digital, pedido pelo celular, pagamento por PIX, cartão ou na entrega, e acompanhamento em tempo real para cozinha e administração.

> **O Sunfood tem dois repositórios.** Este (`sunfood`) é o **site**: as páginas e o app que o cliente, a cozinha e o admin usam. A **API e o banco** (servidor, Supabase, migrações, modelos de e-mail) ficam em [`owdarlley/sunfood-backend`](https://github.com/owdarlley/sunfood-backend).

## 🔗 Acesse pelo GitHub Pages

**https://owdarlley.github.io/sunfood/**

O site é publicado direto da branch `main` deste repositório — qualquer alteração enviada para `main` atualiza automaticamente o endereço acima em poucos minutos.

O front-end detecta sozinho onde está rodando: em `localhost`, fala com a API local (`http://localhost:8787`); publicado (GitHub Pages ou qualquer outro domínio), fala com a API de produção. Se a API de produção estiver fora do ar, o botão **Entrar** mostra "Falha de conexão com o servidor" — as páginas de conteúdo (Sobre, Funcionalidades, etc.) continuam funcionando normalmente.

**Conta de demonstração** (o endereço principal, `index.html`, já abre a tela de login):

| Perfil | E-mail | Senha | Abre |
| --- | --- | --- | --- |
| Cliente | `ana@email.com` | `praia2026` | cardápio da mesa |

As contas de **Administração** (`admin@sunfood.com`, abre o dashboard de vendas) e **Cozinha** (`cozinha@sunfood.com`, abre o kanban de pedidos) não têm a senha publicada: quem tem essas senhas consegue mudar preços, pausar o quiosque e encerrar o dia de verdade, já que o site fala com o banco de produção. Peça a senha ao responsável pelo projeto.

## Como navegar

O endereço principal (`index.html`, ou seja, https://sunfood.app.br/) é a **tela de login** do sistema. Não há site institucional separado: os links do rodapé do login abrem o conteúdo num painel por cima da própria tela, cada um com endereço próprio:

| Link do rodapé | Endereço | Conteúdo |
| --- | --- | --- |
| Conheça o Sunfood | `/#conheca` | Proposta, benefícios, como funciona, os três perfis e sobre o projeto |
| Fale conosco | `/#fale-conosco` | Formulário de contato (grava pela API, `POST /contact`) |
| Termos de uso | `/#termos` | Termos de uso do sistema |
| Privacidade | `/#privacidade` | Política de privacidade, conforme a LGPD |

Os endereços antigos (`inicio.html`, `sobre.html`, `funcionalidades.html`, `como-funciona.html`, `perfis.html`, `mapa.html`, `contato.html`, `termos.html`, `privacidade.html`) continuam funcionando e redirecionam para o painel certo. Outras páginas:

| Página | Arquivo | Conteúdo |
| --- | --- | --- |
| Redefinir senha | `redefinir-senha.html` | Segunda etapa do "esqueci minha senha" (o link do e-mail cai aqui) |
| Protótipo | `prototipo-completo.html` | Protótipo navegável de 38 telas (material da faculdade, sem link no site). `prototipo.html`, a antiga página escura que o envolvia, agora só redireciona para `/#conheca` |

Quem já entrou naquele aparelho vai direto para o seu módulo (exceto quando abre um dos painéis acima). Login correto identifica o perfil e leva ao módulo certo de `app-cliente.dc.html` (cliente, administração ou cozinha).

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
index.html                                   → login + painéis Conheça, Fale conosco, Termos e Privacidade
inicio.html, sobre.html, termos.html, ...    → endereços antigos, redirecionam para o painel certo
redefinir-senha.html                         → segunda etapa da recuperação de senha
app-cliente.dc.html                          → o app (cliente, cozinha e administração), fala com a API
prototipo-completo.html                      → protótipo navegável das telas (material da faculdade)
support.js                                   → script de apoio às páginas (gerado, não editar)
assets/                                      → imagens usadas no protótipo
manifest.json, sw.js, pwa.js, offline.html   → app instalável (PWA): manifesto, service worker, registro e aviso sem internet
icons/                                       → ícones do app instalado (192, 512, maskable, iPhone, favicon)
tests/                                       → testes de tela (Playwright)
```

## Grupo

Dárlley Alves de Almeida — RGM 42298415 — darlley1997@gmail.com
Docente: Cristiano S. Negrão — Análise e Projeto de Sistemas II
