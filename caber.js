// Caber na tela (2026-10-19): do tablet para cima, a tela de entrada e a de
// cadastro diminuem de escala só o necessário para caber na altura da janela,
// sem rolagem e sem mudar o layout (nunca abaixo de 75%). No celular (< 768 px)
// a escala fica em 100%: lá os espaços é que encolhem, pelo CSS da página.
// Uso: sunfoodCaber('.lp') — o elemento recebe zoom e --fit (a escala usada).
(function () {
  var MIN = 0.75;
  window.sunfoodCaber = function (sel) {
    var agendado = false;
    function caber() {
      agendado = false;
      var el = document.querySelector(sel);
      if (!el) return;
      el.style.removeProperty('zoom'); el.style.removeProperty('--fit');
      if (innerWidth < 768) return;
      var alto = document.documentElement.scrollHeight, tela = innerHeight;
      if (alto <= tela + 1) return;
      var z = Math.max(MIN, Math.floor(tela / alto * 1000) / 1000);
      el.style.zoom = z; el.style.setProperty('--fit', z);
    }
    function agendar() { if (!agendado) { agendado = true; requestAnimationFrame(caber); } }
    addEventListener('resize', agendar);
    addEventListener('load', agendar);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(agendar);
    // Avisos, erros dos campos e troca de tela (cadastro ↔ entrada) mudam a altura.
    new MutationObserver(agendar).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'aria-invalid', 'data-step'] });
    agendar();
  };
})();
