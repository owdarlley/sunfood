// Registra o service worker (sw.js) que deixa o Sunfood instalável como app
// ("Instalar" no Chrome/Edge, "Adicionar à Tela de Início" no iPhone).
// Caminho relativo: funciona tanto em localhost quanto em /sunfood/ no GitHub Pages.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function (e) {
      console.warn('Service worker não registrado:', e);
    });
  });
}

// Dentro do app (Android ou instalado pelo navegador) o link "Baixe o app"
// some; o index.html marca o app Android no sessionStorage ao abrir.
try {
  if (sessionStorage.getItem('sunfood_apk') || matchMedia('(display-mode: standalone)').matches || navigator.standalone) document.documentElement.classList.add('sf-instalado');
} catch (e) {}
