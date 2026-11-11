// t3-fleet-gateway owner page: passkey sign-in and browser approval of agent connection requests.
//
// Security rules for this file, checked by test/browser-approval.test.ts:
// - The DOM is built with createElement, createTextNode and setAttribute only; every value from the server is text.
// - Links are hash routes on this page only. The single navigation elsewhere is the OAuth response the gateway returns
//   after the owner allows or denies, and only when it is http(s) on the return origin the owner just reviewed.
// - No browser storage. The session is an HttpOnly cookie the page never sees; the request handle stays in the fragment.

const API_HEADER = 'x-t3fg-dashboard';
const SAFE_ROUTE = /^#\/[A-Za-z0-9/_-]*$/;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;

const ERRORS = {
  signin_required: 'Your sign-in ended. Sign in with your passkey again.',
  gone: 'This request was already answered, expired, or its agent was removed. Start the connection again from your agent.',
  code_not_accepted: 'That enrollment code was not accepted. Codes work once and expire; mint a new one with t3-fleet-gateway owner enroll.',
  throttled: 'Too many wrong enrollment codes. Mint a new code with t3-fleet-gateway owner enroll.',
  passkey_rejected: 'The passkey was not accepted. Try again.',
  passkey_exists: 'This passkey is already set up.',
  passkey_limit: 'The gateway already has its maximum of passkeys. Revoke one with t3-fleet-gateway owner revoke.',
  ceremony_expired: 'That took too long. Try again.',
  not_enrolled: 'No passkey is set up yet.',
  busy: 'Too many sign-ins are in progress. Wait a minute and try again.',
  unavailable: 'The gateway is starting or stopping. Try again in a moment.',
  invalid_request: 'The request was not valid. Reload the page.',
};

export function parseOwnerRoute(hash) {
  const [view, id] = String(hash ?? '').replace(/^#\/?/, '').split('/');
  if (view === 'approve' && HANDLE.test(id ?? '')) return { view: 'approve', handle: id };
  if (view === 'enroll') return { view: 'enroll', handle: null };
  return { view: 'home', handle: null };
}

/** The OAuth response may be followed only to the origin the owner reviewed, over http(s). */
export function safeReturn(url, returnOrigin) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === returnOrigin;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ base64url

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += ALPHABET[n & 63];
  }
  return out;
}

export function fromBase64Url(text) {
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of String(text)) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('invalid base64url');
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
    }
  }
  return new Uint8Array(bytes).buffer;
}

// ------------------------------------------------------------------------------------------------ DOM

function dom(doc) {
  function h(tag, attrs, ...children) {
    const el = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'on') {
        for (const [event, handler] of Object.entries(value)) el.addEventListener(event, handler);
        continue;
      }
      if (/^on/i.test(name) || name === 'style' || name === 'srcdoc') throw new Error(`refusing attribute ${name}`);
      if (name === 'href' && !(typeof value === 'string' && SAFE_ROUTE.test(value))) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false || child === '') continue;
      el.append(typeof child === 'string' || typeof child === 'number' ? doc.createTextNode(String(child)) : child);
    }
    return el;
  }
  return { h };
}

// ------------------------------------------------------------------------------------------------ rendering

export function render(doc, root, model, actions) {
  const { h } = dom(doc);
  const error = model.error ? h('p', { class: 'error', role: 'alert' }, model.error) : null;
  const busy = model.busy;
  let content;
  if (!model.status) {
    content = [h('h1', null, 'Gateway owner'), error ?? h('p', null, 'Loading…')];
  } else if (model.answered) {
    content = [
      h('h1', null, model.answered.approved ? 'Access allowed' : 'Access denied'),
      h('p', null, `Returning to ${model.answered.returnOrigin}.`),
      h('p', { class: 'muted' }, 'You can close this page if your agent does not open.'),
    ];
  } else if (model.route.view === 'enroll') {
    content = [
      h('h1', null, 'Set up a passkey'),
      h('p', null, 'A passkey lets you approve agent connections from this browser without a code. Mint a one-time enrollment code on the gateway machine:'),
      h('p', null, h('code', null, 't3-fleet-gateway owner enroll')),
      error,
      h('form', { on: { submit: (event) => { event.preventDefault(); return actions.enroll(); } } },
        h('label', { class: 'field', for: 'enroll-code' }, 'Enrollment code',
          h('input', { id: 'enroll-code', class: 'code', type: 'text', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', maxlength: '32', required: true,
            on: { input: (event) => { model.enrollCode = event.target.value; } } })),
        h('label', { class: 'field', for: 'enroll-label' }, 'Name for this passkey (optional)',
          h('input', { id: 'enroll-label', type: 'text', maxlength: '60', placeholder: 'Phone',
            on: { input: (event) => { model.enrollLabel = event.target.value; } } })),
        h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit', disabled: busy }, busy ? 'Waiting for passkey…' : 'Create passkey'))),
    ];
  } else if (!model.status.enrolled) {
    content = [
      h('h1', null, 'Browser approval is not set up'),
      h('p', null, 'No passkey is set up for this gateway, so connection requests can only be approved with a code from t3-fleet-gateway pair.'),
      h('p', null, h('a', { href: '#/enroll' }, 'Set up a passkey')),
    ];
  } else if (!model.status.signedIn) {
    content = [
      h('h1', null, model.route.view === 'approve' ? 'Sign in to review a connection request' : 'Gateway owner'),
      h('p', null, 'Sign in with the passkey you set up for this gateway.'),
      error,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', disabled: busy, on: { click: () => actions.signIn() } },
        busy ? 'Waiting for passkey…' : 'Sign in with passkey')),
      h('p', { class: 'muted' }, 'Lost your passkey? Run ', h('code', null, 't3-fleet-gateway owner enroll'), ' on the gateway machine and ', h('a', { href: '#/enroll' }, 'set up a new one'), '.'),
    ];
  } else if (model.route.view === 'approve') {
    content = approveView(h, model, actions, error);
  } else {
    content = [
      h('h1', null, 'Signed in'),
      h('p', null, 'This browser can approve agent connection requests. Open them from the link on an agent’s approval page.'),
      error,
      h('div', { class: 'actions' }, h('button', { type: 'button', disabled: busy, on: { click: () => actions.signOut() } }, 'Sign out')),
    ];
  }
  root.replaceChildren(...[content].flat().filter(Boolean));
}

function approveView(h, model, actions, error) {
  const request = model.request;
  if (!request) return [h('h1', null, 'Connection request'), error ?? h('p', null, 'Loading the request…')];
  const choice = model.choice;
  const handle = model.requestHandle;
  const radio = (name, value, label, checked, disabled) =>
    h('label', null, h('input', { type: 'radio', name, value, checked, disabled, on: { change: () => actions.choose(name, value) } }), label);
  const hostBoxes = request.hosts.map((host) => h('label', null,
    h('input', { type: 'checkbox', name: 'host', value: host.id, checked: choice.hosts.includes(host.id), disabled: !host.allowed,
      on: { change: () => actions.toggleHost(host.id) } }),
    host.label ? `${host.label} (${host.id})` : host.id));
  return [
    h('h1', null, 'Allow this agent to connect?'),
    h('div', { class: 'card' }, h('dl', null,
      h('dt', null, 'Agent'), h('dd', null, request.clientName),
      h('dt', null, 'Returns to'), h('dd', { class: 'mono' }, request.returnOrigin),
      h('dt', null, 'Requested access'), h('dd', null, request.requested))),
    h('p', { class: 'muted' }, 'Allow only if you started this connection from your agent just now and the return address is the agent’s.'),
    error,
    h('fieldset', null, h('legend', null, 'Access'),
      radio('access', 'read', 'Read: see hosts, projects and job status', choice.access === 'read', false),
      radio('access', 'operate', 'Operate: also start, steer, answer and cancel jobs', choice.access === 'operate', !request.allowOperate)),
    h('fieldset', null, h('legend', null, 'Machines'),
      radio('machines', 'all', 'All machines, including hosts added later', choice.machines === 'all', !request.allowAll),
      radio('machines', 'selected', 'Selected machines only', choice.machines === 'selected', false),
      h('div', { class: 'hosts' }, hostBoxes)),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'button', disabled: model.busy, on: { click: () => actions.decide('allow', handle) } }, 'Allow'),
      h('button', { type: 'button', disabled: model.busy, on: { click: () => actions.decide('deny', handle) } }, 'Deny')),
  ];
}

// ------------------------------------------------------------------------------------------------ boot

export function boot(win, doc) {
  const root = doc.getElementById('owner');
  const model = { status: null, route: parseOwnerRoute(win.location.hash), request: null, choice: null, error: null, busy: false, answered: null, enrollCode: '', enrollLabel: '' };
  const draw = () => render(doc, root, model, actions);
  let requestGeneration = 0;

  async function api(path, body) {
    const init = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { [API_HEADER]: '1' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await win.fetch(`api/${path}`, init);
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { ok: response.ok, status: response.status, data: data ?? {} };
  }
  const fail = (result) => {
    const code = result.data.error;
    model.error = code === 'refused' && typeof result.data.detail === 'string' ? result.data.detail
      : Object.hasOwn(ERRORS, code) ? ERRORS[code] : 'Something went wrong. Reload the page.';
    if (code === 'signin_required' && model.status) model.status.signedIn = false;
  };
  const passkeys = () => win.navigator?.credentials;

  async function loadRequest() {
    const generation = ++requestGeneration;
    const handle = model.route.handle;
    model.request = null;
    model.requestHandle = null;
    model.choice = null;
    draw();
    if (model.route.view !== 'approve' || !model.status?.signedIn) return;
    const result = await api('authorizations/view', { handle });
    if (generation !== requestGeneration || parseOwnerRoute(win.location.hash).handle !== handle) return;
    if (!result.ok) return fail(result);
    model.request = result.data;
    model.requestHandle = handle;
    const hosts = result.data.hosts.filter((host) => host.selected).map((host) => host.id);
    model.choice = { access: result.data.access, machines: result.data.machines, hosts };
  }

  async function refresh() {
    const result = await api('owner/status');
    if (!result.ok) { fail(result); draw(); return; }
    model.status = result.data;
    await loadRequest();
    draw();
  }

  const actions = {
    choose(name, value) {
      if (name === 'access') model.choice.access = value;
      else model.choice.machines = value;
      draw();
    },
    toggleHost(id) {
      const hosts = model.choice.hosts;
      model.choice.hosts = hosts.includes(id) ? hosts.filter((host) => host !== id) : [...hosts, id];
      if (!hosts.includes(id)) model.choice.machines = 'selected';
      draw();
    },
    async signIn() {
      model.error = null;
      if (!passkeys()) { model.error = 'This browser does not support passkeys.'; draw(); return; }
      model.busy = true;
      draw();
      try {
        const begin = await api('owner/signin/begin', {});
        if (!begin.ok) return fail(begin);
        const options = begin.data.publicKey;
        const credential = await passkeys().get({ publicKey: {
          challenge: fromBase64Url(options.challenge), rpId: options.rpId, timeout: options.timeout, userVerification: options.userVerification,
          allowCredentials: options.allowCredentials.map((item) => ({ type: item.type, id: fromBase64Url(item.id) })),
        } });
        const finish = await api('owner/signin/finish', { ceremonyId: begin.data.ceremonyId, credential: {
          id: toBase64Url(credential.rawId),
          clientDataJSON: toBase64Url(credential.response.clientDataJSON),
          authenticatorData: toBase64Url(credential.response.authenticatorData),
          signature: toBase64Url(credential.response.signature),
        } });
        if (!finish.ok) return fail(finish);
        model.status.signedIn = true;
        await loadRequest();
      } catch {
        model.error = 'The passkey prompt was cancelled or failed. Try again.';
      } finally {
        model.busy = false;
        draw();
      }
    },
    async enroll() {
      model.error = null;
      if (!passkeys()) { model.error = 'This browser does not support passkeys.'; draw(); return; }
      const code = model.enrollCode;
      model.enrollCode = '';
      model.busy = true;
      draw();
      try {
        const begin = await api('owner/enroll/begin', { code });
        if (!begin.ok) return fail(begin);
        const options = begin.data.publicKey;
        const credential = await passkeys().create({ publicKey: {
          challenge: fromBase64Url(options.challenge), rp: options.rp, timeout: options.timeout, attestation: options.attestation,
          user: { id: fromBase64Url(options.user.id), name: options.user.name, displayName: options.user.displayName },
          pubKeyCredParams: options.pubKeyCredParams, authenticatorSelection: options.authenticatorSelection,
          excludeCredentials: options.excludeCredentials.map((item) => ({ type: item.type, id: fromBase64Url(item.id) })),
        } });
        const label = model.enrollLabel.trim();
        const finish = await api('owner/enroll/finish', { ceremonyId: begin.data.ceremonyId, ...(label ? { label } : {}), credential: {
          clientDataJSON: toBase64Url(credential.response.clientDataJSON),
          attestationObject: toBase64Url(credential.response.attestationObject),
        } });
        if (!finish.ok) return fail(finish);
        model.status = { enrolled: true, signedIn: true };
        win.location.hash = '#/';
        model.route = parseOwnerRoute('#/');
      } catch {
        model.error = 'The passkey prompt was cancelled or failed. Try again.';
      } finally {
        model.busy = false;
        draw();
      }
    },
    async signOut() {
      model.busy = true;
      draw();
      const result = await api('owner/signout', {});
      model.busy = false;
      if (!result.ok) fail(result);
      else model.status.signedIn = false;
      draw();
    },
    async decide(decision, handle) {
      // Consent belongs to the request actually displayed, including when a hashchange event is still queued.
      if (model.busy || !model.request || handle !== model.requestHandle || handle !== model.route.handle ||
          handle !== parseOwnerRoute(win.location.hash).handle) return;
      const request = model.request;
      const generation = requestGeneration;
      const choice = { ...model.choice, hosts: [...model.choice.hosts] };
      model.error = null;
      model.busy = true;
      draw();
      try {
        const body = decision === 'deny' ? { handle, decision }
          : { handle, decision, access: choice.access, hostsMode: choice.machines, hosts: choice.machines === 'selected' ? choice.hosts : [] };
        const result = await api('authorizations/decide', body);
        // A response for a page the owner left must never change consent or navigate the current page.
        if (generation !== requestGeneration || handle !== parseOwnerRoute(win.location.hash).handle) return;
        if (!result.ok) {
          fail(result);
          if (result.data.error === 'gone') model.request = null;
          return;
        }
        const { responseUrl, returnOrigin, approved } = result.data;
        if (!safeReturn(responseUrl, returnOrigin) || returnOrigin !== request.returnOrigin) {
          model.error = 'The gateway answered with an unexpected return address. Start the connection again from your agent.';
          return;
        }
        model.answered = { approved: approved === true, returnOrigin };
        draw();
        win.location.assign(responseUrl);
      } catch {
        if (generation === requestGeneration) model.error = 'The answer could not be confirmed. Start the connection again from your agent.';
      } finally {
        model.busy = false;
        draw();
      }
    },
  };

  win.addEventListener('hashchange', () => {
    model.route = parseOwnerRoute(win.location.hash);
    model.error = null;
    model.answered = null;
    return loadRequest().then(draw);
  });
  draw();
  return { ready: refresh(), model };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('owner')) boot(window, document);
