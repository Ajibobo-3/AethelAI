(() => {
  const node = document.querySelector('#nodeCount');
  const latency = document.querySelector('#latency');
  const throughput = document.querySelector('#throughput');
  const feed = document.querySelector('#activityFeed');
  const menu = document.querySelector('.menu-toggle');
  const topbar = document.querySelector('.topbar');
  const regions = ['north-america', 'western-europe', 'asia-pacific', 'south-america'];
  const models = ['text-generation', 'summarization', 'embeddings', 'vision'];
  const number = value => value.toLocaleString('en-US');
  let request = 68421;

  function updateMetrics() {
    node.textContent = number(14290 + Math.round(Math.random() * 90 - 45));
    latency.textContent = String(16 + Math.round(Math.random() * 5));
    throughput.textContent = number(2380 + Math.round(Math.random() * 250));
  }

  function addActivity() {
    const line = document.createElement('div');
    const region = regions[Math.floor(Math.random() * regions.length)];
    const model = models[Math.floor(Math.random() * models.length)];
    request += 1;
    line.className = 'feed-line';
    line.innerHTML = `<b>req_${request}</b> &nbsp;→&nbsp; ${region} &nbsp;·&nbsp; ${model} &nbsp;<em>ROUTED</em>`;
    feed.prepend(line);
    while (feed.children.length > 3) feed.lastElementChild.remove();
  }

  menu.addEventListener('click', () => {
    const isOpen = topbar.classList.toggle('menu-open');
    menu.setAttribute('aria-expanded', String(isOpen));
    menu.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
  });
  topbar.querySelectorAll('.nav-links a').forEach(link => link.addEventListener('click', () => {
    topbar.classList.remove('menu-open');
    menu.setAttribute('aria-expanded', 'false');
  }));

  document.querySelector('#year').textContent = new Date().getFullYear();
  updateMetrics();
  addActivity();
  addActivity();
  setInterval(updateMetrics, 2600);
  setInterval(addActivity, 1900);
})();
