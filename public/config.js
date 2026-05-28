// Локально (npm start): API на том же хосте — пустая строка.
// На Netlify: подставляется URL Render (см. meta voluntis-api в index.html).
(function () {
  var host = location.hostname;
  if (/^(localhost|127\.0\.0\.1)$/i.test(host)) {
    window.VOLUNTIS_API_BASE = '';
    window.VOLUNTIS_BACKEND_URL = '';
    return;
  }
  var meta = document.querySelector('meta[name="voluntis-api"]');
  var url = (meta && meta.getAttribute('content')) || '';
  url = String(url).trim().replace(/\/$/, '');
  if (url && url.indexOf('YOUR-RENDER') === -1) {
    window.VOLUNTIS_API_BASE = url;
    window.VOLUNTIS_BACKEND_URL = url;
  }
})();
