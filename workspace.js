(() => {
  const $ = selector => document.querySelector(selector);
  const storage = {
    key: 'aethel_workspace_api_key',
    session: 'aethel_workspace_session_id',
    messages: id => `aethel_workspace_messages_${id}`,
  };
  const toolDefinitions = [
    {
      type: 'function',
      function: {
        name: 'calculator',
        description: 'Evaluate a basic arithmetic expression.',
        parameters: {
          type: 'object',
          properties: { expression: { type: 'string', maxLength: 200 } },
          required: ['expression'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_utc_time',
        description: 'Get the current time in UTC.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  ];

  const form = $('#composerForm');
  const input = $('#promptInput');
  const sendButton = $('#sendButton');
  const list = $('#messageList');
  const welcome = $('#welcomeState');
  const scrollArea = $('#conversationScroll');
  const workingCard = $('#workingCard');
  const keyDialog = $('#keyDialog');
  const keyInput = $('#apiKeyInput');
  const keyError = $('#keyError');
  const clearKeyButton = $('#clearKeyButton');
  let apiKey = readStorage(storage.key) || '';
  let sessionId = readStorage(storage.session) || createSessionId();
  let messages = readMessages(sessionId);
  let isSending = false;

  writeStorage(storage.session, sessionId);
  renderMessages();
  updateKeyStatus();
  updateComposer();

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }

  function removeStorage(key) {
    try { localStorage.removeItem(key); } catch (_) { /* Storage may be disabled in private browsing. */ }
  }

  function createSessionId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `pilot-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function readMessages(id) {
    try {
      const saved = JSON.parse(readStorage(storage.messages(id)) || '[]');
      return Array.isArray(saved) ? saved.filter(message => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string') : [];
    } catch (_) { return []; }
  }

  function saveMessages() {
    const succeeded = writeStorage(storage.messages(sessionId), JSON.stringify(messages.slice(-80)));
    if (!succeeded) showToast('Browser storage unavailable', 'This conversation may not stay visible after you close the tab.', 'warning');
  }

  function updateKeyStatus() {
    const saved = Boolean(apiKey);
    $('#headerKeyIndicator').classList.toggle('key-saved', saved);
    $('#headerKeyLabel').textContent = saved ? 'Key saved' : 'Add API key';
    $('#sidebarKeyStatus').textContent = saved ? 'Pilot key saved here' : 'Not configured';
    clearKeyButton.hidden = !saved;
  }

  function updateComposer() {
    sendButton.disabled = isSending || !input.value.trim();
    input.disabled = isSending;
    $('#newSessionButton').disabled = isSending;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { scrollArea.scrollTop = scrollArea.scrollHeight; });
  }

  function renderMessages() {
    list.replaceChildren();
    welcome.hidden = messages.length > 0;
    for (const message of messages) list.appendChild(createMessage(message));
    scrollToBottom();
  }

  function createMessage(message) {
    const article = document.createElement('article');
    article.className = `message message-${message.role}`;
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.role === 'assistant' ? 'A' : 'Y';
    const content = document.createElement('div');
    content.className = 'message-content';
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = message.role === 'assistant' ? 'Aethel agent' : 'You';
    const text = document.createElement('p');
    text.className = 'message-text';
    text.textContent = message.content;
    content.append(label, text);
    if (message.status === 'max_iterations_reached') {
      const continuation = document.createElement('p');
      continuation.className = 'message-text message-followup';
      continuation.textContent = 'The five-step run limit was reached. Send another message to continue this session.';
      content.appendChild(continuation);
    }
    if (Array.isArray(message.steps)) {
      const toolSteps = message.steps.filter(step => step?.type === 'tool');
      if (toolSteps.length) content.appendChild(createToolSteps(toolSteps));
    }
    article.append(avatar, content);
    return article;
  }

  function createToolSteps(steps) {
    const details = document.createElement('details');
    details.className = 'tool-steps';
    const summary = document.createElement('summary');
    summary.textContent = `${steps.length} tool ${steps.length === 1 ? 'step' : 'steps'} completed`;
    const listElement = document.createElement('ol');
    listElement.className = 'tool-step-list';
    steps.forEach((step, index) => {
      const item = document.createElement('li');
      item.className = 'tool-step';
      const number = document.createElement('span');
      number.className = 'tool-step-number';
      number.textContent = String(index + 1);
      const body = document.createElement('div');
      body.className = 'tool-step-body';
      const title = document.createElement('div');
      title.className = 'tool-step-title';
      title.textContent = toolLabel(step.name);
      const output = document.createElement('p');
      output.className = 'tool-step-output';
      output.textContent = formatToolOutput(step.output);
      body.append(title, output);
      item.append(number, body);
      listElement.appendChild(item);
    });
    details.append(summary, listElement);
    return details;
  }

  function toolLabel(name) {
    if (name === 'calculator') return 'Calculator · completed';
    if (name === 'get_utc_time') return 'UTC time · completed';
    return 'Tool · completed';
  }

  function formatToolOutput(output) {
    if (output == null) return 'Completed';
    if (output.error) return `Could not complete: ${output.error}`;
    const value = output.result;
    if (value && typeof value === 'object' && typeof value.utc === 'string') return value.utc;
    if (value && typeof value === 'object' && value.result !== undefined) return String(value.result);
    return typeof value === 'string' ? value : JSON.stringify(value ?? output);
  }

  function openKeyDialog() {
    keyError.hidden = true;
    keyError.textContent = '';
    keyInput.value = apiKey;
    keyInput.type = 'password';
    $('#toggleKeyVisibility').textContent = 'Show';
    $('#toggleKeyVisibility').setAttribute('aria-label', 'Show API key');
    clearKeyButton.hidden = !apiKey;
    if (!keyDialog.open) keyDialog.showModal();
    requestAnimationFrame(() => keyInput.focus());
  }

  function showToast(title, description, kind = 'error', actionLabel = '', action = null) {
    const toast = document.createElement('div');
    toast.className = `toast${kind === 'success' ? ' toast-success' : ''}`;
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = kind === 'success' ? '✓' : '!';
    const copy = document.createElement('div');
    copy.className = 'toast-copy';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const detail = document.createElement('span');
    detail.textContent = description;
    copy.append(heading, detail);
    if (actionLabel && action) {
      const actionButton = document.createElement('button');
      actionButton.className = 'toast-action';
      actionButton.type = 'button';
      actionButton.textContent = actionLabel;
      actionButton.addEventListener('click', () => { action(); toast.remove(); });
      copy.appendChild(document.createElement('br'));
      copy.appendChild(actionButton);
    }
    const dismiss = document.createElement('button');
    dismiss.className = 'toast-dismiss';
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss notification');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => toast.remove());
    toast.append(icon, copy, dismiss);
    $('#toastRegion').appendChild(toast);
    window.setTimeout(() => toast.remove(), 8000);
  }

  async function sendMessage(rawPrompt) {
    const task = rawPrompt.trim();
    if (!task || isSending) return;
    if (!apiKey) {
      input.value = task;
      updateComposer();
      showToast('Pilot key required', 'Add your temporary Aethel customer key to run an agent request.', 'error', 'Configure key', openKeyDialog);
      return;
    }

    isSending = true;
    messages.push({ role: 'user', content: task });
    renderMessages();
    input.value = '';
    resizeInput();
    updateComposer();
    workingCard.hidden = false;
    $('#workingTitle').textContent = 'Aethel is working';
    $('#workingDetail').textContent = 'Sending your task to the agent. Tool steps appear as the run completes…';
    scrollToBottom();
    const started = Date.now();
    const progressTimer = window.setInterval(() => {
      const elapsed = Date.now() - started;
      $('#workingDetail').textContent = elapsed > 5000
        ? 'The model is taking longer. Completed tool steps will appear with the response…'
        : 'The agent is working. Completed tool steps will appear with the response…';
    }, 1200);

    try {
      const response = await fetch('/api/v1/agent/run', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ task, tools: toolDefinitions, session_id: sessionId }),
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        messages.pop();
        renderMessages();
        input.value = task;
        if (response.status === 401) {
          showToast('API key not accepted', data.error?.message || data.error?.code || 'Check that this is an active aethel_live_ customer key.', 'error', 'Update key', openKeyDialog);
        } else if (response.status === 429) {
          const reset = data.resets_at ? new Date(data.resets_at) : null;
          const time = reset && Number.isFinite(reset.getTime()) ? ` Resets at ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(reset)}.` : '';
          showToast('Daily pilot limit reached', `${data.message || 'Daily pilot limit reached.'}${time} Ask your pilot administrator to top up this key.`, 'error');
        } else {
          const message = typeof data.error === 'string' ? data.message : data.error?.message;
          showToast('Request could not be completed', message || `The gateway returned HTTP ${response.status}. You can try again.`, 'error');
        }
        return;
      }

      messages.push({
        role: 'assistant',
        content: typeof data.output === 'string' && data.output.trim()
          ? data.output
          : data.status === 'max_iterations_reached'
            ? 'I reached the five-step limit for this run. Send a follow-up to continue.'
            : 'The agent completed the task without a text response.',
        steps: Array.isArray(data.steps) ? data.steps : [],
        status: data.status,
      });
      saveMessages();
      renderMessages();
    } catch (_) {
      messages.pop();
      renderMessages();
      input.value = task;
      showToast('Connection problem', 'Could not reach the Aethel gateway. Check your connection and try again.', 'error');
    } finally {
      window.clearInterval(progressTimer);
      workingCard.hidden = true;
      isSending = false;
      updateComposer();
      input.focus();
      scrollToBottom();
    }
  }

  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  $('#headerKeyButton').addEventListener('click', openKeyDialog);
  $('#openKeySettings').addEventListener('click', openKeyDialog);
  $('#closeKeyDialog').addEventListener('click', () => keyDialog.close());
  keyDialog.addEventListener('click', event => { if (event.target === keyDialog) keyDialog.close(); });
  $('#toggleKeyVisibility').addEventListener('click', event => {
    const visible = keyInput.type === 'password';
    keyInput.type = visible ? 'text' : 'password';
    event.currentTarget.textContent = visible ? 'Hide' : 'Show';
    event.currentTarget.setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key');
  });
  $('#keyForm').addEventListener('submit', event => {
    event.preventDefault();
    const value = keyInput.value.trim();
    if (!/^aethel_live_[A-Za-z0-9_-]{30,}$/.test(value)) {
      keyError.textContent = 'Enter a valid Aethel customer key beginning with aethel_live_. Admin and provider keys are not accepted.';
      keyError.hidden = false;
      keyInput.focus();
      return;
    }
    if (!writeStorage(storage.key, value)) {
      keyError.textContent = 'This browser blocked local storage. Enable local storage or try another browser.';
      keyError.hidden = false;
      return;
    }
    apiKey = value;
    updateKeyStatus();
    keyDialog.close();
    showToast('API key saved', 'Your pilot key is stored in this browser.', 'success');
    input.focus();
  });
  $('#clearKeyButton').addEventListener('click', () => {
    removeStorage(storage.key);
    apiKey = '';
    keyInput.value = '';
    updateKeyStatus();
    keyDialog.close();
    showToast('API key removed', 'The saved key was removed from this browser.', 'success');
  });
  $('#newSessionButton').addEventListener('click', () => {
    sessionId = createSessionId();
    messages = [];
    writeStorage(storage.session, sessionId);
    renderMessages();
    input.value = '';
    resizeInput();
    updateComposer();
    input.focus();
    showToast('New session started', 'A new Aethel agent session is ready.', 'success');
  });
  document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => sendMessage(button.dataset.prompt || '')));
  form.addEventListener('submit', event => {
    event.preventDefault();
    sendMessage(input.value);
  });
  input.addEventListener('input', () => { resizeInput(); updateComposer(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!sendButton.disabled) form.requestSubmit();
    }
  });
})();
