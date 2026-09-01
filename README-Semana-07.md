# Sunfood — Semana 07 · Tela de login / acesso restrito

**Status: em progresso.** A página de login ainda não faz parte da entrega.

## O que já está no site

O botão laranja **Entrar** está no menu fixo de todas as páginas, na posição definitiva, como porta única da área restrita. Por enquanto ele não tem destino: o link fica inativo até a página de login existir.

## O que falta

| Item | Situação |
| --- | --- |
| Página de login (campos usuário/e-mail e senha) | a fazer |
| Validação e mensagens de erro no front-end | a fazer |
| Credenciais de demonstração por perfil | a fazer |
| Redirecionamento pós-login por perfil (cliente, cozinha, administração) | a fazer |

## Regras de acesso já definidas

O login do Sunfood não abre um sistema único: ele resolve qual dos três perfis está entrando e monta a interface a partir disso. O cliente enxerga apenas a própria mesa — cardápio, carrinho, pedido em andamento e a conta a dividir — e nunca os pedidos de outras mesas nem qualquer dado financeiro. A cozinha recebe todos os pedidos em preparo e pode mover a comanda entre as etapas da fila, mas não vê valores, faturamento ou dados de pagamento, porque essa informação não participa da decisão dela. A administração é o único perfil sem restrição: acompanha vendas, estoque, cardápio e equipe, e é a única que altera preços e concede permissões. Essa separação nasce das regras de negócio do quiosque, não da tecnologia: quem cozinha não precisa saber quanto entrou no caixa, e quem consome não pode enxergar a operação. O mesmo formulário atenderá os três porque a credencial é que carrega o papel.

O app do cliente (`app-cliente.dc.html`) já lê `module` e `screen` no carregamento (`aplicarRota()`) e valida os dois contra a tabela `SCREENS`, então o redirecionamento por perfil só depende da página de login.

## Grupo

Dárlley Alves de Almeida — RGM 42298415 — darlley1997@gmail.com
Docente: Cristiano S. Negrão — Análise e Projeto de Sistemas II
