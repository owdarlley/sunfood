# Sunfood — Semana 05 · Página "Fale conosco"

Página de contato e pré-agendamento do sistema, integrada ao menu principal e ao rodapé de todas as páginas.

## Arquivos

| Arquivo | Conteúdo |
| --- | --- |
| `index.html` | Home: chamada principal, app do cliente navegável e índice das páginas |
| `funcionalidades.html` | Benefícios do sistema para o quiosque |
| `como-funciona.html` | O fluxo em três passos, do guarda-sol à cozinha |
| `perfis.html` | O que cliente, cozinha e administração enxergam |
| `prototipo.html` | Protótipo navegável de 38 telas |
| `sobre.html` | Página "Sobre Nós" (entrega da Semana 04) |
| `contato.html` | Página "Fale conosco" (entrega da Semana 05) |
| `app-cliente.dc.html`, `prototipo-completo.html`, `support.js` | Arquivos carregados pelas páginas |

## Integração à navegação

O link **Fale conosco** foi adicionado ao menu fixo das sete páginas, sempre depois de "Sobre nós", e também à lista de páginas repetida no rodapé. Na própria página o item aparece marcado com o sublinhado laranja, seguindo o padrão do site. O formulário responde em uma coluna única no celular e em duas colunas no desktop, com os canais diretos e o atalho para o protótipo ao lado.

## Campos do formulário

| Campo | Tipo | Obrigatório |
| --- | --- | --- |
| Nome | texto | sim |
| E-mail ou telefone | texto, aceita e-mail válido ou telefone com DDD | sim |
| Motivo do contato | lista: reserva, dúvida de cardápio, dúvida de pagamento, suporte a pedido, parceria | sim |
| Mensagem | texto longo, mínimo de 10 caracteres | sim |

O envio é validado no próprio navegador e devolve um protocolo de atendimento (ex.: `SF-4821`). Por ser protótipo acadêmico, nenhuma mensagem é transmitida ou armazenada.

## Histórias de usuário apoiadas por esta página

| HU | História | Campos que a sustentam |
| --- | --- | --- |
| HU-11 | **Entrar em contato com o quiosque** — como cliente, quero enviar uma mensagem ao quiosque informando nome e forma de contato, para tirar dúvidas antes de ir à praia. | nome, e-mail ou telefone, mensagem |
| HU-12 | **Solicitar reserva antecipada de mesa ou guarda-sol** — como cliente, quero pedir uma reserva com data e número de pessoas, para garantir lugar em dia de movimento. | nome, contato, motivo, mensagem |
| HU-13 | **Abrir suporte sobre um pedido** — como cliente, quero relatar um problema com um pedido já feito, para que a administração corrija ou estorne o valor. | contato, motivo, mensagem |
| HU-14 | **Triar as solicitações recebidas** — como administrador, quero receber as solicitações separadas por motivo, para encaminhar cada caso ao responsável certo. | motivo (classificação) |

## Papel da página no funil do sistema

A página de contato é a porta de entrada do funil do Sunfood para quem ainda não está sentado no quiosque. Antes do QR Code da mesa ou do guarda-sol, ela captura o primeiro contato: nome, um e-mail ou telefone e o motivo — reserva antecipada, dúvida sobre cardápio e pagamento, suporte a um pedido ou proposta de parceria. Esse registro funciona como pré-cadastro: os mesmos dados que o cliente informaria ao ler o QR Code já chegam à administração, que faz a triagem por motivo e encaminha cada caso para o responsável — reserva para a administração, problema de pedido para o suporte, item em falta para a cozinha. Assim o quiosque conhece a demanda antes do movimento começar, dimensiona equipe e estoque para o dia e reduz a espera na areia. Quando o cliente finalmente escaneia o QR Code, ele já é conhecido pelo sistema e cai direto no cardápio, fechando o caminho entre interesse, cadastro e primeiro pedido.

## Grupo

Dárlley Alves de Almeida — RGM 42298415 — darlley1997@gmail.com
Docente: Cristiano S. Negrão — Análise e Projeto de Sistemas II
