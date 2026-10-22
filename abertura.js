// Abertura "Sol na areia" do SunFood: o sol nasce atrás do mar no fundo
// areia, os raios se abrem, o nome aparece ao lado e a abertura some
// sozinha (ou no primeiro toque/tecla). Carregada logo no começo do <body>
// do login (index.html) e do app (app-cliente.dc.html), para cobrir a tela
// antes do primeiro quadro.
// - Roda na primeira página da sessão: no login, ou no app quando quem já
//   entrou é mandado direto para o seu módulo (o login sai antes de mostrar).
// - O logo voa para o seu lugar no topo, no login e no app; no app a
//   abertura antes espera o app montar.
// - Não roda em link direto para painel do rodapé (#termos etc.) nem em
//   navegador automatizado (os testes de fluxo não esperam por ela).
(function () {
  if (window.SUNFOOD_SAINDO || !document.body || !document.body.animate) return;
  try { if (sessionStorage.getItem('sunfood_abertura')) return; sessionStorage.setItem('sunfood_abertura', '1'); } catch (e) {}
  var noApp = /app-cliente/.test(location.pathname);
  if ((!noApp && location.hash) || navigator.webdriver) return;
  var CSS = [
    '.sfb{position:fixed;inset:0;z-index:9999;cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.sfb-bg{position:absolute;inset:0;background:#F7F5F0}',
    '.sfb-mid{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;margin-top:-6%}',
    '.sfb-lock{display:flex;align-items:center;gap:14px;height:56px}',
    '.sfb-hz{display:block;width:56px;height:56px;overflow:hidden}',
    '.sfb-sun{display:block;width:56px;height:56px}',
    '.sfb-rot{transform-origin:24px 24px}',
    '.sfb-ray{fill:none;stroke:#F5B83D;stroke-width:3.4;stroke-linecap:round;stroke-dasharray:6}',
    '.sfb-name{font:800 42px/1 \'Manrope\',system-ui,sans-serif;letter-spacing:-.02em;color:#1F5A63;white-space:nowrap}',
    '.sfb-sea{width:180px;height:22px;overflow:visible}',
    '.sfb-sea path{fill:none;stroke-linecap:round;stroke-width:3;stroke-dasharray:240}',
    '.sfb-w1{stroke:#1F5A63}',
    '.sfb-w2{stroke:#5BA9AE}',
    '@media (min-width:1025px){.sfb-lock{height:64px}.sfb-hz,.sfb-sun{width:64px;height:64px}.sfb-name{font-size:48px}.sfb-sea{width:208px}}'
  ].join('');
  var estilo = document.createElement('style');
  estilo.textContent = CSS;
  document.head.appendChild(estilo);
  var reduz = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var raios = [[24,5,24,10],[24,38,24,43],[5,24,10,24],[38,24,43,24],[10.6,10.6,14.1,14.1],[33.9,33.9,37.4,37.4],[10.6,37.4,14.1,33.9],[33.9,14.1,37.4,10.6]];
  var el = document.createElement('div');
  el.className = 'sfb';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML =
    '<div class="sfb-bg"></div><div class="sfb-mid"><div class="sfb-lock">' +
      '<span class="sfb-hz"><svg class="sfb-sun" viewBox="0 0 48 48"><g class="sfb-rot">' +
        raios.map(function (r) { return '<path class="sfb-ray" d="M' + r[2] + ' ' + r[3] + 'L' + r[0] + ' ' + r[1] + '"/>'; }).join('') +
        '<circle cx="24" cy="24" r="9" fill="#F5B83D"/></g></svg></span>' +
      '<b class="sfb-name">SunFood</b></div>' +
      '<svg class="sfb-sea" viewBox="0 0 200 24"><path class="sfb-w1" d="M2 8c12-6 22-6 33 0s22 6 33 0 22-6 33 0 22 6 33 0 22-6 33 0 22 6 31 0"/>' +
      '<path class="sfb-w2" d="M22 18c12-6 22-6 33 0s22 6 33 0 22-6 33 0 22 6 33 0 22-6 22-3"/></svg></div>';
  document.body.appendChild(el);
  var $ = function (s) { return el.querySelector(s); };
  var anims = [], timers = [], saindo = false, logo = null;
  function a(n, kf, o) { anims.push(n.animate(kf, Object.assign({ fill: 'both', easing: 'cubic-bezier(.2,.8,.2,1)' }, o))); }
  function fim() {
    if (logo) logo.style.visibility = '';
    el.remove();
    estilo.remove();
    document.removeEventListener('keydown', sair);
  }
  function sair() {
    if (saindo) return; saindo = true;
    timers.forEach(clearTimeout);
    anims.forEach(function (x) { x.finish(); });
    $('.sfb-lock').style.transform = ''; $('.sfb-name').style.clipPath = '';
    logo = noApp ? marcaDoApp() : document.querySelector('.lp-logo');
    var alvo = logo && logo.querySelector('svg');
    if (reduz || !alvo) { el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).onfinish = fim; return; }
    // O logo (sol + nome) encolhe até o lugar dele no topo (login ou app).
    // Os raios do sol do app vão até mais perto da borda do desenho (32 de
    // 36) que os da abertura (38 de 48); a escala casa o tamanho dos raios
    // e o centro do sol cai no centro do sol de destino.
    var lock = $('.sfb-lock'), L = lock.getBoundingClientRect(), sol = $('.sfb-hz').getBoundingClientRect(), r = alvo.getBoundingClientRect();
    var s = (r.height * (noApp ? 32 / 36 : 38 / 48)) / (sol.height * 38 / 48);
    var px = sol.left + sol.width / 2 - L.left, py = sol.top + sol.height / 2 - L.top;
    var tx = r.left + r.width / 2 - L.left - s * px, ty = r.top + r.height / 2 - L.top - s * py;
    logo.style.visibility = 'hidden';
    lock.style.transformOrigin = '0 0';
    lock.animate([{ transform: 'none' }, { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')' }],
      { duration: 520, easing: 'cubic-bezier(.65,0,.25,1)', fill: 'forwards' }).onfinish = fim;
    // No app o nome pode ser branco (cabeçalho escuro): a cor acompanha.
    var cor = getComputedStyle(logo).color;
    $('.sfb-name').animate([{ color: '#1F5A63' }, { color: cor }], { duration: 520, easing: 'cubic-bezier(.65,0,.25,1)', fill: 'forwards' });
    $('.sfb-sea').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(16px)' }], { duration: 260, fill: 'forwards' });
    $('.sfb-bg').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, delay: 80, easing: 'ease-out', fill: 'forwards' });
  }
  // Marca (sol + "SunFood") visível no topo do app, onde o logo pousa.
  function marcaDoApp() {
    var marcas = document.querySelectorAll('#dc-root .brand, #dc-root .adm-brand');
    for (var i = 0; i < marcas.length; i++) {
      var b = marcas[i].getBoundingClientRect();
      if (b.width && b.height && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth && /SunFood/.test(marcas[i].textContent)) return marcas[i];
    }
    return null;
  }
  // No app, só sai depois que ele montou (no máximo 4 s), para não revelar a tela vazia.
  function quandoPronto(fn) {
    if (!noApp) return fn();
    var limite = Date.now() + 4000;
    (function ver() {
      var raiz = document.getElementById('dc-root');
      if ((raiz && raiz.children.length && !document.documentElement.classList.contains('sf-espera')) || Date.now() > limite) fn();
      else timers.push(setTimeout(ver, 100));
    })();
  }
  if (reduz) timers.push(setTimeout(function () { quandoPronto(sair); }, 450));
  else {
    a($('.sfb-w1'), [{ strokeDashoffset: 240 }, { strokeDashoffset: 0 }], { duration: 700, easing: 'ease-out' });
    a($('.sfb-w2'), [{ strokeDashoffset: 240 }, { strokeDashoffset: 0 }], { duration: 700, delay: 120, easing: 'ease-out' });
    a($('.sfb-sun'), [{ transform: 'translateY(105%)' }, { transform: 'none' }], { duration: 620, delay: 120, easing: 'cubic-bezier(.2,.9,.25,1.1)' });
    a($('.sfb-rot'), [{ transform: 'rotate(-60deg)' }, { transform: 'none' }], { duration: 1000, delay: 120 });
    [].forEach.call(el.querySelectorAll('.sfb-ray'), function (r, i) { a(r, [{ strokeDashoffset: 6, opacity: 0 }, { strokeDashoffset: 0, opacity: 1 }], { duration: 260, delay: 450 + i * 40 }); });
    // O sol começa no centro; o nome ainda escondido não pode tirá-lo do meio.
    var nome = $('.sfb-name');
    nome.style.clipPath = 'inset(0 100% 0 0)';
    $('.sfb-lock').style.transform = 'translateX(' + (nome.offsetWidth + 14) / 2 + 'px)';
    timers.push(setTimeout(function () {
      var meio = (nome.offsetWidth + 14) / 2;
      a($('.sfb-lock'), [{ transform: 'translateX(' + meio + 'px)' }, { transform: 'none' }], { duration: 520 });
      a(nome, [{ clipPath: 'inset(0 100% 0 0)', transform: 'translateX(-12px)' }, { clipPath: 'inset(0 0 0 0)', transform: 'none' }], { duration: 480, delay: 20 });
      $('.sfb-lock').style.transform = ''; nome.style.clipPath = '';
    }, 600));
    timers.push(setTimeout(function () { quandoPronto(sair); }, 1250));
  }
  el.addEventListener('pointerdown', sair);
  document.addEventListener('keydown', sair);
})();
