# Sunfood — Semana 06 · Menu principal e mapa do sistema

## 1. Menu principal

Implementado no cabeçalho fixo das oito páginas, idêntico em todas, com o item da página atual marcado por sublinhado laranja.

| Item | Destino | Entrega de origem | Status |
| --- | --- | --- | --- |
| Home / Início | `index.html` (no logotipo, à esquerda) | S03 | funcionando |
| Funcionalidades | `funcionalidades.html` | S03 | funcionando |
| Como funciona | `como-funciona.html` | S03 | funcionando |
| Perfis de acesso | `perfis.html` | S02 | funcionando |
| Protótipo completo | `prototipo.html` | S03 | funcionando |
| **Sobre nós** | `sobre.html` | S04 | funcionando |
| **Fale conosco** (contato / agende) | `contato.html` | S05 | funcionando |
| **Entrar** (login / área restrita — item opcional) | `index.html?login=1` → app do cliente, painel da cozinha, painel da administração | S03 | funcionando |

Os três itens obrigatórios do enunciado (Home, Sobre nós, Contato) e o item opcional (Login) estão presentes. O botão **Entrar** fica separado à direita, em laranja, fora da lista de conteúdo. O rodapé repete a lista completa e acrescenta o link **Mapa do sistema**, que não entra no menu por ser documento de entrega e não conteúdo para o cliente do quiosque. Todos os links foram conferidos página por página nas duas versões da entrega (arquivos autocontidos e pasta do GitHub Pages).

Login de demonstração: `ana@email.com` / `praia2026`.

## 2. Mapa de páginas (versão revisada)

O sistema tem duas camadas, e o mapa mostra as duas.

```
CAMADA PÚBLICA — site institucional (sem autenticação)

                            HOME
                        (index.html)
                              |
        --------------- menu principal ---------------
        |         |         |         |        |        |
Funcionalidades  Como     Perfis   Protótipo  Sobre    Fale
                funciona de acesso completo    nós    conosco
                              |
                              v
                    ENTRAR · ÁREA RESTRITA
              (login no site ou QR Code da mesa)
                              |
CAMADA AUTENTICADA — o sistema (38 telas)
                              |
        --------------------------------------------
        |                     |                     |
    CLIENTE               ADMINISTRAÇÃO          COZINHA
   PWA · celular          Web · balcão         Web · tablet
     25 telas               10 telas             3 telas
        |                     |                     |
  Acesso e cadastro (4)   Vendas do dia (3)   Fila de preparo (1)
  Cardápio e carrinho (7) Cardápio e itens(3) Detalhe comanda (1)
  Pedido e acomp. (6)     Estoque (2)         Fila vazia (1)
  Pagamento e conta (5)   Equipe e fecham.(2)
  Perfil e histórico (3)
```

A página `mapa.html` traz esse esquema desenhado, o user flow em cinco passos e a tabela de nomenclatura item por item.

## 3. User flow típico

**Home → Sobre nós → Fale conosco → Entrar → primeiro pedido.**

Atalho: quem já está na praia pula a camada pública inteira, lê o QR Code do guarda-sol, faz o cadastro na hora e cai direto no cardápio.

## 4. Justificativa da ordem e da nomenclatura

A ordem do menu reproduz a sequência de perguntas de quem chega ao site: o que é isso (Home, no logotipo), o que ele faz (Funcionalidades), como funciona na prática (Como funciona), para quem serve (Perfis de acesso), como é de verdade (Protótipo completo), quem está por trás (Sobre nós) e como falar com o quiosque (Fale conosco). Os nomes usam as palavras do cliente, e não termos de análise: "Fale conosco" em vez de "Formulário de contato", "Perfis de acesso" em vez de "Atores do sistema". O botão "Entrar" fica separado à direita, em laranja, porque é ação e não conteúdo — abre a área restrita, onde vive o sistema. O caminho típico é Home → Sobre nós → Fale conosco → Entrar: o visitante entende a proposta, ganha confiança na origem do projeto, deixa o contato ou pede uma reserva e só então acessa o sistema. Quem já está na praia pula esse percurso e entra pelo QR Code da mesa, caindo direto no cardápio.

## Grupo

Dárlley Alves de Almeida — RGM 42298415 — darlley1997@gmail.com
Docente: Cristiano S. Negrão — Análise e Projeto de Sistemas II
