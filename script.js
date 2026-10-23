(() => {
  const $ = selector => document.querySelector(selector);
  const menu = $('.menu-toggle');
  const topbar = $('.topbar');
  const statusText = $('#serviceStatus');
  const statusDot = $('#serviceStatusDot');
  const headline = $('#serviceHeadline');
  const description = $('#serviceDescription');
  const databaseStatus = $('#databaseStatus');
  const providerStatus = $('#providerStatus');

  menu.addEventListener('click', () => {
    const isOpen = topbar.classList.toggle('menu-open');
    menu.setAttribute('aria-expanded', String(isOpen));
    menu.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
  });
  topbar.querySelectorAll('.nav-links a').forEach(link => link.addEventListener('click', () => {
    topbar.classList.remove('menu-open');
    menu.setAttribute('aria-expanded', 'false');
  }));

  $('#year').textContent = new Date().getFullYear();

  function showStatus(text, ready) {
    statusText.textContent = text;
    statusDot.classList.toggle('service-ready', ready);
    statusDot.classList.toggle('service-down', !ready);
    $('#headerStatusText').textContent = ready ? 'API READY' : 'SETUP REQUIRED';
    $('#footerStatusText').textContent = ready ? 'API READY' : 'SETUP REQUIRED';
    $('#headerStatusDot').className = ready ? 'service-ready' : 'service-down';
    $('#footerStatusDot').className = ready ? 'service-ready' : 'service-down';
  }

  async function loadHealth() {
    try {
      const response = await fetch('/api/health', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const data = await response.json();
      const ready = response.ok && data.status === 'ready';
      showStatus(ready ? 'READY' : 'SETUP REQUIRED', ready);
      databaseStatus.textContent = data.components?.usage_store === 'connected' ? 'CONNECTED' : 'NOT READY';
      providerStatus.textContent = data.components?.inference_provider === 'configured' ? 'CONFIGURED' : 'NOT READY';
      $('#modelStatus').textContent = data.default_model || 'NOT SET';
      headline.textContent = ready ? 'Gateway is ready for requests.' : 'Gateway setup is incomplete.';
      description.textContent = ready
        ? 'The database is reachable and the inference provider is configured.'
        : 'Apply the database migration and configure the required server secrets.';
    } catch (_) {
      showStatus('UNAVAILABLE', false);
      databaseStatus.textContent = 'UNAVAILABLE';
      providerStatus.textContent = 'UNAVAILABLE';
      headline.textContent = 'Health check is unavailable.';
      description.textContent = 'The API service could not be reached from this deployment.';
    }
  }
  loadHealth();
  setInterval(loadHealth, 30000);
})();
