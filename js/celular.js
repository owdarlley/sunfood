// Zoom de pinça e de toque duplo desligado dentro do app (Android ou
// instalado), a pedido do Dárlley (2026-10-24): o app abre como tela de app,
// sem ampliar. No navegador o zoom continua, para quem precisa ampliar.
(function () {
  var app = /^android-app:\/\/br\.app\.sunfood/.test(document.referrer);
  try { app = app || !!sessionStorage.getItem('sunfood_apk'); } catch (e) {}
  app = app || matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!app) return;
  var vp = document.querySelector('meta[name="viewport"]');
  if (vp && !/user-scalable/.test(vp.content)) vp.content += ', maximum-scale=1, user-scalable=no';
  document.documentElement.style.touchAction = 'pan-x pan-y';
  // Safari do iPhone ignora user-scalable=no: o gesto de pinça é barrado aqui.
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
})();

// "Site para computador" do Chrome no app Android (2026-10-22). O APK é uma
// Trusted Web Activity: quem desenha a tela é o próprio Chrome do celular,
// com as configurações dele. Se a pessoa liga "Site para computador" no
// Chrome, o app também abre assim: o Chrome ignora o <meta viewport>, monta a
// página com 980 px de largura e encolhe tudo para caber na tela (o app vira
// a versão de computador, minúscula). O site não consegue desligar isso.
// Aqui o app desfaz o efeito: se a largura da página passa bem da largura da
// tela do aparelho (screen.width), ele aplica um zoom no <html> que volta tudo
// ao tamanho real e faz as faixas de tela (@media, matchMedia, innerWidth)
// enxergarem a largura do aparelho, então o celular volta a ver a versão de
// celular. O vh/vw também cresceria com o zoom, por isso é dividido de volta.
// Só no app (Android ou instalado); no navegador a escolha da pessoa vale.
// Carregado antes de tudo no <head>, para a tela já abrir no tamanho certo.
(function () {
  var raiz = document.documentElement;
  var app = /^android-app:\/\/br\.app\.sunfood/.test(document.referrer);
  try { app = app || !!sessionStorage.getItem('sunfood_apk'); } catch (e) {}
  app = app || matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  var tela = screen.width, pagina = raiz.clientWidth || innerWidth;
  if (!app || !tela || !navigator.maxTouchPoints || pagina < tela * 1.2) return;
  var k = pagina / tela;
  window.sunfoodEscalaPc = k;
  raiz.classList.add('sf-modo-pc');
  raiz.style.zoom = k;
  // Sem a meta viewport, o Chrome do Android aumenta textos sozinho.
  raiz.style.setProperty('-webkit-text-size-adjust', '100%');
  raiz.style.setProperty('text-size-adjust', '100%');

  // Faixas de tela em px: com a página k vezes mais larga, (min-width:768px)
  // vira (min-width:768k px), e a página de 980 px responde como o celular.
  function faixa(q) {
    return String(q).replace(/((?:min-|max-)?(?:device-)?(?:width|height)\s*:\s*)([\d.]+)px/g, function (_, p, n) { return p + Math.round(n * k * 100) / 100 + 'px'; });
  }
  var mm = window.matchMedia;
  window.matchMedia = function (q) { return mm.call(window, faixa(q)); };
  var iw = Object.getOwnPropertyDescriptor(window, 'innerWidth'), ih = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  function medida(d, nome) {
    var get = d && d.get;
    if (!get) return;
    Object.defineProperty(window, nome, { configurable: true, get: function () { return Math.round(get.call(window) / k); } });
  }
  medida(iw, 'innerWidth'); medida(ih, 'innerHeight');

  // vh/vw (e dvh, svh...) crescem junto com o zoom: divide de volta por k.
  var unidade = /(-?[\d.]+)([dsl]?v(?:h|w|min|max))\b/g;
  function semZoom(v) { return v.replace(unidade, function (_, n, u) { return 'calc(' + n + u + ' / ' + k + ')'; }); }
  var feitas = typeof WeakSet === 'function' ? new WeakSet() : null;
  function regras(lista) {
    for (var i = 0; i < lista.length; i++) {
      var r = lista[i];
      if (feitas) { if (feitas.has(r)) continue; feitas.add(r); }
      if (r.media && r.conditionText !== undefined && r.media.mediaText) {
        var t = faixa(r.media.mediaText);
        if (t !== r.media.mediaText) r.media.mediaText = t;
      }
      var s = r.style;
      if (s) for (var j = 0; j < s.length; j++) {
        var p = s[j], v = s.getPropertyValue(p);
        if (unidade.test(v)) { unidade.lastIndex = 0; s.setProperty(p, semZoom(v), s.getPropertyPriority(p)); }
        unidade.lastIndex = 0;
      }
      if (r.cssRules) regras(r.cssRules);
    }
  }
  function folhas() {
    for (var i = 0; i < document.styleSheets.length; i++) {
      var f = document.styleSheets[i];
      // Folha de outro site (fontes do Google) não deixa ler as regras.
      try { regras(f.cssRules); } catch (e) {}
    }
  }
  folhas();
  // <style> que chegam depois (o resto do <head>, telas montadas pelo app).
  new MutationObserver(function (m) {
    for (var i = 0; i < m.length; i++) for (var j = 0; j < m[i].addedNodes.length; j++) {
      var n = m[i].addedNodes[j];
      if (n.nodeName === 'STYLE' || n.nodeName === 'LINK' || (n.parentNode && n.parentNode.nodeName === 'STYLE')) { folhas(); return; }
    }
  }).observe(raiz, { childList: true, subtree: true, characterData: true });
  document.addEventListener('DOMContentLoaded', folhas);
  addEventListener('load', folhas);
})();
