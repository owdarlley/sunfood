# Sunfood

Sistema de pedidos online para quiosques de praia — projeto acadêmico da disciplina de Análise e Projeto de Sistemas II.

O site resolve a dor de quiosques com alta rotatividade de clientes e atendimento disperso entre mesas e guarda-sóis: hoje o processo é quase todo em papel. O Sunfood propõe cardápio digital, pedido pelo celular, conta dividida sem cálculo manual e acompanhamento em tempo real para cozinha e administração.

## 🔗 Acesse pelo GitHub Pages

**https://owdarlley.github.io/sunfood/**

O site é publicado direto da branch `main` deste repositório — qualquer alteração enviada para `main` atualiza automaticamente o endereço acima em poucos minutos.

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

O botão **Entrar**, no menu fixo de todas as páginas, abre o login (direto na home, ou via `index.html?login=1` a partir de qualquer outra página). Login correto identifica o perfil e leva ao módulo certo de `app-cliente.dc.html` (cliente, administração ou cozinha); login incorreto mostra "Credenciais inválidas". `prototipo-completo.html` e `support.js` são arquivos de apoio carregados pelas páginas acima.

## Rodando localmente

O site é 100% estático — basta abrir `index.html` num navegador, ou servir a pasta com qualquer servidor HTTP simples:

```bash
python3 -m http.server 8000
```

e acessar `http://localhost:8000`. Não há build nem dependências para instalar.

## Estrutura de pastas

```
index.html, sobre.html, contato.html, ...   → páginas do site
app-cliente.dc.html, prototipo-completo.html → protótipos navegáveis
support.js                                   → script de apoio às páginas
assets/                                      → imagens usadas no projeto
```

## Grupo

Dárlley Alves de Almeida — RGM 42298415 — darlley1997@gmail.com
Docente: Cristiano S. Negrão — Análise e Projeto de Sistemas II
