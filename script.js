// ═══════════════════════════════════════════════════════
// AETHEL AI — Live Terminal Engine
// Simulates real-time system telemetry & terminal output
// ═══════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────
  const CONFIG = {
    INITIAL_BLOCK: 18_420_000,
    NODE_RANGE: [128, 256],
    LATENCY_RANGE: [8, 24],
    ROUTING_RANGE: [12_400, 14_800],
    INFERENCE_RANGE: [1.2, 3.8],
    SETTLEMENT_RANGE: [120, 450],
    LOG_INTERVAL: 2200,
    BLOCK_INTERVAL: 6000,
    TELEMETRY_INTERVAL: 3000,
  };

  // ── DOM References ─────────────────────────────────
  const els = {
    nodeCount:          document.getElementById('nodeCount'),
    latencyMs:          document.getElementById('latencyMs'),
    uptimeClock:        document.getElementById('uptimeClock'),
    blockHeight:        document.getElementById('blockHeight'),
    terminalLog:        document.getElementById('terminalLog'),
    routingThroughput:  document.getElementById('routingThroughput'),
    inferenceLatency:   document.getElementById('inferenceLatency'),
    settlementTime:     document.getElementById('settlementTime'),
  };

  // ── Utilities ──────────────────────────────────────
  const rand = (min, max) => Math.random() * (max - min) + min;
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const formatNum = (n) => n.toLocaleString('en-US');

  // ── Uptime Clock ───────────────────────────────────
  const startTime = Date.now();

  function updateUptime() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const days = Math.floor(elapsed / 86400);
    const hours = Math.floor((elapsed % 86400) / 3600);
    const mins = Math.floor((elapsed % 3600) / 60);
    const secs = elapsed % 60;
    if (els.uptimeClock) {
      els.uptimeClock.textContent = `${pad(days)}:${pad(hours)}:${pad(mins)}:${pad(secs)}`;
    }
  }

  // ── Block Height ───────────────────────────────────
  let currentBlock = CONFIG.INITIAL_BLOCK + randInt(0, 5000);

  function updateBlock() {
    currentBlock += randInt(1, 3);
    if (els.blockHeight) {
      els.blockHeight.textContent = `#${formatNum(currentBlock)}`;
    }
  }

  // ── Telemetry ──────────────────────────────────────
  function updateTelemetry() {
    const nodes = randInt(...CONFIG.NODE_RANGE);
    const latency = randInt(...CONFIG.LATENCY_RANGE);
    const routing = randInt(...CONFIG.ROUTING_RANGE);
    const inference = rand(...CONFIG.INFERENCE_RANGE).toFixed(1);
    const settlement = randInt(...CONFIG.SETTLEMENT_RANGE);

    if (els.nodeCount) els.nodeCount.textContent = nodes;
    if (els.latencyMs) els.latencyMs.textContent = `${latency}ms`;
    if (els.routingThroughput) els.routingThroughput.textContent = `${formatNum(routing)} tasks/s`;
    if (els.inferenceLatency) els.inferenceLatency.textContent = `${inference} ms avg`;
    if (els.settlementTime) els.settlementTime.textContent = `${settlement} ms finality`;
  }

  // ── Terminal Log ───────────────────────────────────
  const LOG_TEMPLATES = [
    () => `<span class="text-terminal-dim">[${timestamp()}]</span> <span class="text-terminal-green">INFO</span>  gpu_cluster.route — dispatched ${randInt(50,200)} tasks to node pool <span class="text-terminal-cyan">us-east-${randInt(1,4)}</span>`,
    () => `<span class="text-terminal-dim">[${timestamp()}]</span> <span class="text-terminal-green">INFO</span>  inference.engine — batch ${randInt(1000,9999)} completed in <span class="text-terminal-amber">${rand(1.1,3.9).toFixed(1)}ms</span>`,
    () => `<span class="text-terminal-dim">[${timestamp()}]</span> <span class="text-terminal-green">INFO</span>  settlement.atomic — finalized tx <span class="text-terminal-cyan">0x${randHex(8)}</span> AETHEL↔NVDA <span class="text-terminal-amber">${randInt(100,500)}ms</span>`,
    () => `<span class="text-terminal-dim">[${timestamp()}]</span> <span class="text-terminal-green">INFO</span>  health.monitor — ${randInt(128,256)} nodes reporting healthy, <span class="text-terminal-green">0 degraded</span>`,
    () => `<span class="text-terminal-dim">[${timestamp()}]</span> <span class="text-terminal-cyan">SYNC</span>  chain.block — new block <span class="text-terminal-cyan">#${formatNum(currentBlock)}</span> confirmed, ${randInt(40,180)} txns`,
    () => `<span class="text-terminal-dim">[${timestamp()}]</span> <span class="text-terminal-green">INFO</span>  buyback.lock — protocol reserve locked, <span class="text-terminal-amber">${rand(2.1,8.4).toFixed(2)}M</span> $AETHEL secured`,
    () => `<span class="text-terminal-dim">[${timestamp()}]</span> <span class="text-terminal-green">INFO</span>  router.optimizer — latency target met: <span class="text-terminal-green">${randInt(8,24)}ms</span> p99 across ${randInt(3,8)} regions`,
    () => `<span class="text-terminal-dim">[${timestamp()}]</span> <span class="text-terminal-cyan">SYNC</span>  pons.bridge — cross-asset swap executed: <span class="text-terminal-cyan">${randInt(500,5000)}</span> AETHEL → NVDA`,
    () => `<span class="text-terminal-dim">[${timestamp()}]</span> <span class="text-terminal-green">INFO</span>  compute.sched — GPU utilization <span class="text-terminal-amber">${randInt(78,97)}%</span> — scaling pool <span class="text-terminal-cyan">eu-west-${randInt(1,3)}</span>`,
  ];

  function timestamp() {
    const now = new Date();
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  function randHex(len) {
    return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  }

  const MAX_LOG_LINES = 12;

  function appendLog() {
    if (!els.terminalLog) return;

    const template = LOG_TEMPLATES[randInt(0, LOG_TEMPLATES.length - 1)];
    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerHTML = template();

    els.terminalLog.appendChild(line);

    // Remove overflow lines
    while (els.terminalLog.children.length > MAX_LOG_LINES) {
      els.terminalLog.removeChild(els.terminalLog.firstChild);
    }

    // Auto-scroll
    els.terminalLog.scrollTop = els.terminalLog.scrollHeight;
  }

  // ── Scroll Reveal ──────────────────────────────────
  function initScrollReveal() {
    const sections = document.querySelectorAll('section');
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
    );

    sections.forEach((section) => {
      section.style.opacity = '0';
      section.style.transform = 'translateY(16px)';
      section.style.transition = 'opacity 0.6s ease-out, transform 0.6s ease-out';
      observer.observe(section);
    });
  }

  // ── Bootstrap ──────────────────────────────────────
  function init() {
    // Immediate first paint
    updateUptime();
    updateBlock();
    updateTelemetry();

    // Seed initial log lines
    for (let i = 0; i < 6; i++) {
      setTimeout(appendLog, i * 120);
    }

    // Start intervals
    setInterval(updateUptime, 1000);
    setInterval(updateBlock, CONFIG.BLOCK_INTERVAL);
    setInterval(updateTelemetry, CONFIG.TELEMETRY_INTERVAL);
    setInterval(appendLog, CONFIG.LOG_INTERVAL);

    // Scroll animations
    initScrollReveal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
