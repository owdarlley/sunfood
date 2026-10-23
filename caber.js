// Caber na tela (2026-10-19): do tablet para cima, a tela de entrada e a de
// cadastro usam a MESMA escala, calculada só pela altura da janela, para as
// duas caberem sem rolagem (nunca abaixo de 75%). No celular (< 768 px) os
// espaços é que encolhem, pelo CSS da página. Desde 2026-10-20 a escala
// nunca passa de 83% (ESCALA), a mesma do app, também no celular.
// Carregado no <head>: a escala sai antes da tela aparecer, então a página
// nunca abre grande para depois encolher. A escala vai em --fit no <html>; o
// CSS de cada página aplica (zoom:var(--fit)) na tela de entrada/cadastro.
// ALTURA é a altura da mais alta das duas telas em 100% (o cadastro no
// computador, a entrada no tablet, onde tudo fica empilhado); o teste
// tests/fluxo/sem-rolagem.mjs confere que continua certa. Se a tela atual
// ainda passar da janela (vários erros abertos), só ela diminui mais um pouco.
(function () {
  var MIN = 0.75, ESCALA = 0.83, raiz = document.documentElement;
  function altura(w) { return w < 1024 ? 968 : w < 1040 ? 776 : 758; }
  function base() {
    if (innerWidth < 768) return ESCALA;
    return Math.max(MIN, Math.min(ESCALA, Math.floor(innerHeight / altura(innerWidth) * 1000) / 1000));
  }
  function aplicar(z) {
    if (z === 1) raiz.style.removeProperty('--fit'); else raiz.style.setProperty('--fit', z);
  }
  aplicar(base());
  // Altura da janela em px (--janela), no lugar de 100dvh na tela de entrada
  // e no cadastro: no app Android (Samsung), ao recarregar, o dvh chegava
  // maior que a janela de verdade e a tela passava da altura (rolagem, tudo
  // maior). A altura do <html> (clientHeight) é a da janela visível.
  // Teclado aberto (campo em foco e só a altura diminuiu) não conta: a tela
  // não encolhe enquanto a pessoa digita, como já acontecia com o dvh.
  // No app com "Site para computador" (celular.js) a página tem zoom: a
  // altura medida volta para a escala da página.
  var jl = 0, jh = 0;
  function janela() {
    var pc = window.sunfoodEscalaPc || 1;
    var w = raiz.clientWidth / pc, h = raiz.clientHeight / pc || innerHeight;
    var foco = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (!h || (foco && w === jl && h < jh)) return;
    jl = w; jh = h;
    raiz.style.setProperty('--janela', h + 'px');
  }
  janela();
  addEventListener('resize', janela);
  addEventListener('pageshow', janela);
  addEventListener('load', janela);
  window.sunfoodCaber = function (sel) {
    var agendado = false, teclado = false;
    function caber() {
      agendado = false;
      if (teclado) return;
      var z = base();
      aplicar(z);
      if (innerWidth < 768) return;
      // Ainda passa da janela? Só esta tela diminui o que faltar (mínimo 75%).
      // A altura vem do layout (offsetHeight, em 100%), sem o mínimo de uma
      // tela cheia e sem contar animações de entrada (translateY).
      var el = document.querySelector(sel);
      if (!el || z <= MIN) return;
      el.style.minHeight = '0px';
      var alto = el.offsetHeight;
      el.style.minHeight = '';
      if (alto * z <= innerHeight + 1) return;
      aplicar(Math.max(MIN, Math.floor(innerHeight / alto * 1000) / 1000));
    }
    function agendar() { if (!agendado) { agendado = true; requestAnimationFrame(caber); } }
    // Teclado do tablet abrindo (só a altura diminui com um campo em foco): a
    // escala fica como está, para a tela não pular enquanto a pessoa digita.
    var largura = innerWidth, altura0 = innerHeight, toque = matchMedia('(pointer:coarse)').matches;
    addEventListener('resize', function () {
      var foco = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (toque && innerWidth === largura && innerHeight < altura0 && foco) teclado = true;
      else if (innerWidth !== largura || innerHeight > altura0) teclado = false;
      largura = innerWidth; altura0 = innerHeight;
      if (!teclado) agendar();
    });
    addEventListener('load', agendar);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(agendar);
    new MutationObserver(agendar).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'aria-invalid', 'data-step'] });
    agendar();
  };
})();
