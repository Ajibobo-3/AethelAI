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
  const pilotAccessButton = $('#requestPilotAccess');
  const pilotAccessStatus = $('#pilotAccessStatus');

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

  pilotAccessButton.addEventListener('click', async () => {
    if (pilotAccessButton.disabled) return;
    pilotAccessButton.disabled = true;
    pilotAccessStatus.textContent = 'Creating your temporary demo key…';
    pilotAccessStatus.classList.remove('pilot-access-error');
    pilotAccessButton.firstChild.textContent = 'Creating demo key… ';
    try {
      const response = await fetch('/api/v1/keys/public-demo', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || result.error?.message || 'Demo key creation failed. Please try again.');
      if (typeof result.api_key !== 'string' || !/^aethel_live_[A-Za-z0-9_-]{30,}$/.test(result.api_key)) {
        throw new Error('The demo key response was incomplete. Please try again.');
      }
      localStorage.setItem('aethel_workspace_api_key', result.api_key);
      pilotAccessStatus.textContent = 'Demo key saved securely in this browser. Opening the workspace…';
      window.location.assign('/workspace');
    } catch (error) {
      pilotAccessStatus.textContent = error?.name === 'QuotaExceededError'
        ? 'Browser storage is full. Clear space in local storage, then request a key again.'
        : error.message || 'Could not save your demo key in this browser.';
      pilotAccessStatus.classList.add('pilot-access-error');
      pilotAccessButton.disabled = false;
      pilotAccessButton.firstChild.textContent = 'Request Pilot Access ';
    }
  });

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
      const fallback = data.components?.fallback_provider || 'not_configured';
      $('#fallbackStatus').textContent = fallback === 'enabled' ? 'ENABLED' : fallback === 'available_disabled' ? 'AVAILABLE · OFF' : fallback.toUpperCase().replaceAll('_', ' ');
      headline.textContent = ready ? 'Gateway is ready for requests.' : 'Gateway setup is incomplete.';
      description.textContent = ready
        ? 'The database is reachable and the inference provider is configured.'
        : 'Apply the database migration and configure the required server secrets.';
    } catch (_) {
      showStatus('UNAVAILABLE', false);
      databaseStatus.textContent = 'UNAVAILABLE';
      providerStatus.textContent = 'UNAVAILABLE';
      $('#fallbackStatus').textContent = 'UNAVAILABLE';
      headline.textContent = 'Health check is unavailable.';
      description.textContent = 'The API service could not be reached from this deployment.';
    }
  }
  loadHealth();
  setInterval(loadHealth, 30000);
})();
