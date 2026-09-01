# Sunfood — Semana 08 · Listagem principal (cardápio)

## Decisão de escopo

O cardápio funcional é uma tela do **app autenticado** (`app-cliente.dc.html`, tela "menu"), não uma página do site institucional. O site não duplica essa listagem e não tem item "Cardápio" no menu: quem exerce essa função é o botão **Entrar**, que leva à tela de login (`login.html`). Autenticado como cliente, o visitante cai no cardápio dentro do app.

## Artefato

Listagem principal na tela "menu" do app do cliente, acessível pelo botão **Entrar** do menu fixo (presente nas nove páginas do site), pelos atalhos de cardápio da home e pelo QR Code da mesa, no quiosque.

## Formato da listagem

Cards, um por item, com os campos que a decisão de pedido exige:

| Campo | Exemplo |
| --- | --- |
| Nome | Wrap de frango grelhado |
| Descrição | Frango, alface e molho da casa |
| Preço | R$ 28,00 |
| Categoria | Lanches |
| Disponibilidade | item esgotado fica visível, marcado |

O filtro por categoria (Todos, Bebidas, Lanches) fica no topo da lista e o carrinho acumula no rodapé fixo da tela.

## Prévia na home

A home traz quatro destaques do cardápio (um por categoria) com nome, descrição, preço e porção. O botão da seção — **"Entrar para ver o cardápio →"** — leva ao login, coerente com a decisão de escopo: o site desperta o interesse, o app entrega a listagem.

## Navegação

| Ponto de entrada | Destino |
| --- | --- |
| Botão "Entrar" do menu fixo | área restrita (login em progresso) |
| CTA "Ver o cardápio" no hero da home | área restrita (login em progresso) |
| Link da prévia do cardápio na home | área restrita (login em progresso) |
| QR Code da mesa, no quiosque | cadastro na hora e cardápio direto |

## Histórias de usuário atendidas

| HU | História |
| --- | --- |
| HU-01 | **Ver o cardápio do quiosque** — como cliente, quero consultar os itens com preço e descrição, para decidir o que pedir antes de chamar o garçom. |
| HU-02 | **Filtrar por categoria** — como cliente, quero separar bebidas e lanches, para encontrar o que procuro sem percorrer a lista inteira. |
| HU-04 | **Saber o que está esgotado** — como cliente, quero ver quais itens acabaram, para não pedir algo indisponível e ter de escolher de novo. |
| HU-21 | **Manter o cardápio atualizado** — como administrador, quero cadastrar itens, preços e disponibilidade, para que a lista do cliente reflita o estoque do dia. |

## Relação da listagem com as HU

A listagem é o coração do domínio: sem cardápio não há pedido, e é dela que dependem o carrinho, a comanda da cozinha e o relatório de vendas. Por isso ela vive no app, junto do carrinho e do pagamento, e não como página solta do site — o cliente que consulta o cardápio já está a um toque de pedir, o que liga HU-01 e HU-02, do lado do cliente, à HU-21, do lado da administração. Cada cartão traz apenas o que a decisão exige: nome, descrição, preço, categoria e disponibilidade. Os itens esgotados continuam visíveis, mas marcados (HU-04), porque esconder o que acabou faz o cliente perguntar no balcão e devolve ao quiosque o trabalho que o sistema deveria poupar. No site, os atalhos de cardápio da home funcionam como declaração de intenção: pedem o acesso primeiro e entregam a listagem no lugar onde ela é útil. O menu fixo não repete o item — o botão "Entrar" é a porta única para a área restrita.

## Grupo

Dárlley Alves de Almeida — RGM 42298415 — darlley1997@gmail.com
Docente: Cristiano S. Negrão — Análise e Projeto de Sistemas II
