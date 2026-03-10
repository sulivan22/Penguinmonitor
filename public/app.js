const AUTO_REFRESH_MS = 30000;
const HISTORY_RANGE_OPTIONS = ['1h', '6h', '24hr', '7d', '14d'];
const HISTORY_LIMIT_BY_RANGE = {
  '1h': 240,
  '6h': 1440,
  '24hr': 5760,
  '7d': 20000,
  '14d': 40000
};

const homeBtn = document.getElementById('homeBtn');
const hostsNav = document.getElementById('hostsNav');
const toggleAddHostBtn = document.getElementById('toggleAddHostBtn');
const addHostForm = document.getElementById('addHostForm');

const pageKicker = document.getElementById('pageKicker');
const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');

const homeView = document.getElementById('homeView');
const hostView = document.getElementById('hostView');

const authTypeSelect = document.getElementById('authType');
const passwordGroup = document.getElementById('passwordGroup');
const privateKeyGroup = document.getElementById('privateKeyGroup');
const passphraseGroup = document.getElementById('passphraseGroup');

let hosts = [];
let activeView = { type: 'home' };
let refreshInFlight = false;
let cpuRange = '1h';
let ramRange = '1h';
let viewNonce = 0;
let hostLogsState = {
  containerName: '',
  logs: '',
  error: ''
};

function showToast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setAuthFormMode() {
  const keyMode = authTypeSelect.value === 'key';
  passwordGroup.classList.toggle('hidden', keyMode);
  privateKeyGroup.classList.toggle('hidden', !keyMode);
  passphraseGroup.classList.toggle('hidden', !keyMode);
}

function statusDot(status) {
  const safe = status || 'unknown';
  return `<span class="status-dot ${safe}"></span>${safe}`;
}

function getActiveHost() {
  if (activeView.type !== 'host') return null;
  return hosts.find((host) => host.id === activeView.hostId) || null;
}

function formatAgo(dateLike) {
  if (!dateLike) return '--';
  const timestamp = new Date(dateLike).getTime();
  if (Number.isNaN(timestamp)) return '--';

  const diff = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diff < 60) return `${diff}s ago`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function createGauge(valuePercent, label, color) {
  const safePercent = Math.max(0, Math.min(100, Number(valuePercent) || 0));
  const circumference = 2 * Math.PI * 40;
  const offset = circumference - (safePercent / 100) * circumference;

  return `
    <article class="gauge-card">
      <p class="gauge-title">${escapeHtml(label)}</p>
      <div class="gauge-wrap">
        <svg width="104" height="104" viewBox="0 0 104 104" aria-hidden="true">
          <circle class="gauge-track" cx="52" cy="52" r="40"></circle>
          <circle class="gauge-bar" cx="52" cy="52" r="40" style="stroke:${color};stroke-dasharray:${circumference};stroke-dashoffset:${offset}"></circle>
        </svg>
        <div class="gauge-value">${safePercent.toFixed(0)}%</div>
      </div>
    </article>
  `;
}

function createUptimeCard(uptimeHuman) {
  return `
    <article class="gauge-card">
      <p class="gauge-title">Uptime</p>
      <div class="gauge-wrap" style="width:auto;height:auto;min-height:104px;display:grid;place-items:center;padding:0 10px;">
        <div class="gauge-value" style="position:static;font-size:1.05rem;text-align:center;line-height:1.2;">${escapeHtml(
          uptimeHuman || '--'
        )}</div>
      </div>
    </article>
  `;
}

function chartSvg(series, color) {
  if (!series.length) {
    return '<div class="empty">No history yet</div>';
  }

  const maxPoints = 800;
  const sampled =
    series.length > maxPoints
      ? series.filter((_, index) => index % Math.ceil(series.length / maxPoints) === 0)
      : series;

  const width = 560;
  const height = 180;
  const pad = 20;
  const points = sampled.map((value, i) => {
    const x = pad + (i / Math.max(1, sampled.length - 1)) * (width - pad * 2);
    const y = height - pad - (Math.max(0, Math.min(100, value)) / 100) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = [`${pad},${height - pad}`, ...points, `${width - pad},${height - pad}`].join(' ');
  const gid = `g-${String(color).replace(/[^a-zA-Z0-9]/g, '')}`;

  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="chart">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.3"></stop>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"></stop>
        </linearGradient>
      </defs>
      <polyline points="${area}" fill="url(#${gid})" stroke="none"></polyline>
      <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
    </svg>
  `;
}

function rangeSelectHtml(type, selected) {
  return `
    <select class="range-select" data-range-type="${type}">
      ${HISTORY_RANGE_OPTIONS.map((option) => `<option value="${option}" ${option === selected ? 'selected' : ''}>${option}</option>`).join('')}
    </select>
  `;
}

function renderHostsNav() {
  hostsNav.innerHTML = '';
  if (!hosts.length) {
    hostsNav.innerHTML = '<p class="muted">No hosts added</p>';
    return;
  }

  hosts.forEach((host) => {
    const row = document.createElement('div');
    row.className = 'host-row';
    const active = activeView.type === 'host' && activeView.hostId === host.id;
    row.innerHTML = `
      <button class="nav-btn ${active ? 'active' : ''}" data-host-id="${host.id}">
        ${escapeHtml(host.name)}
      </button>
      <button class="host-delete" data-del-host="${host.id}" title="Delete host">x</button>
    `;
    hostsNav.appendChild(row);
  });
}

function renderHome(summary) {
  const totals = summary?.totals || { totalHosts: 0, onlineHosts: 0, cpuAvg: null, ramAvg: null };
  const rows = summary?.rows || [];

  homeView.innerHTML = `
    <section class="summary-cards">
      <article class="mini-card"><p class="mini-title">Total hosts</p><p class="mini-value">${totals.totalHosts}</p></article>
      <article class="mini-card"><p class="mini-title">Online</p><p class="mini-value">${totals.onlineHosts}</p></article>
      <article class="mini-card"><p class="mini-title">CPU avg</p><p class="mini-value">${totals.cpuAvg == null ? '--' : `${totals.cpuAvg}%`}</p></article>
      <article class="mini-card"><p class="mini-title">RAM avg</p><p class="mini-value">${totals.ramAvg == null ? '--' : `${totals.ramAvg}%`}</p></article>
    </section>

    <article class="panel card">
      <h2>Host summary</h2>
      <div class="table-wrap ${rows.length ? '' : 'empty'}">
        ${
          rows.length
            ? `
          <table>
            <thead>
              <tr>
                <th>Host</th>
                <th>Status</th>
                <th>CPU</th>
                <th>RAM</th>
                <th>Uptime</th>
                <th>Containers</th>
                <th>Last read</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (row) => `
                <tr>
                  <td>${escapeHtml(row.name)} <span class="muted">(${escapeHtml(row.host)})</span></td>
                  <td>${statusDot(row.status)}</td>
                  <td>${row.cpuUsagePercent == null ? '--' : `${row.cpuUsagePercent}%`}</td>
                  <td>${row.memoryUsagePercent == null ? '--' : `${row.memoryUsagePercent}%`}</td>
                  <td>${escapeHtml(row.uptimeHuman || '--')}</td>
                  <td>${row.containersSummary.running}/${row.containersSummary.total}</td>
                  <td>${formatAgo(row.lastFetchedAt)}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        `
            : 'Add hosts from the left panel to begin.'
        }
      </div>
    </article>
  `;
}

function renderHostView(detail, cpuHistory, ramHistory) {
  const host = detail?.item;
  if (!host) {
    hostView.innerHTML = '<div class="empty card">Host not found.</div>';
    return;
  }

  const snapshot = host.latestSnapshot;
  if (!snapshot) {
    hostView.innerHTML = '<div class="empty card">No metrics yet. Waiting for next auto refresh.</div>';
    return;
  }

  const cpu = snapshot.cpu?.usagePercent ?? 0;
  const ram = snapshot.memory?.usagePercent ?? 0;
  const uptimeHuman = snapshot.uptime?.human || '--';
  const containerRatio = snapshot.containersSummary?.total
    ? (snapshot.containersSummary.running / snapshot.containersSummary.total) * 100
    : 0;

  const cpuSeries = (cpuHistory?.items || [])
    .map((point) => point.cpuUsagePercent)
    .filter((value) => typeof value === 'number');
  const ramSeries = (ramHistory?.items || [])
    .map((point) => point.memoryUsagePercent)
    .filter((value) => typeof value === 'number');

  const logsTitle = hostLogsState.containerName
    ? `Logs: ${escapeHtml(hostLogsState.containerName)}`
    : 'Container logs';
  const logsContent = hostLogsState.error
    ? escapeHtml(hostLogsState.error)
    : hostLogsState.logs
      ? escapeHtml(hostLogsState.logs)
      : 'Click "Logs" on a container to load output.';

  hostView.innerHTML = `
    <section class="host-top">
      ${createGauge(cpu, 'CPU', 'var(--blue)')}
      ${createGauge(ram, 'RAM', 'var(--orange)')}
      ${createUptimeCard(uptimeHuman)}
      ${createGauge(containerRatio, 'Containers', 'var(--blue)')}
    </section>

    <section class="host-grid">
      <article class="panel card chart-card">
        <div class="chart-head">
          <h3>CPU history</h3>
          ${rangeSelectHtml('cpu', cpuRange)}
        </div>
        ${chartSvg(cpuSeries, '#5168ff')}
      </article>

      <article class="panel card chart-card">
        <div class="chart-head">
          <h3>RAM history</h3>
          ${rangeSelectHtml('ram', ramRange)}
        </div>
        ${chartSvg(ramSeries, '#f39363')}
      </article>
    </section>

    <article class="panel card">
      <div class="chart-head">
        <div>
          <h3>Docker containers</h3>
          <p class="muted">${escapeHtml(host.username)}@${escapeHtml(host.host)} | Updated ${formatAgo(
    host.lastFetchedAt
  )}</p>
        </div>
      </div>

      <div class="table-wrap ${snapshot.containers?.length ? '' : 'empty'}">
        ${
          snapshot.containers?.length
            ? `
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Image</th>
                <th>State</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${snapshot.containers
                .map((container) => {
                  const safeName = escapeHtml(container.name);
                  const safeImage = escapeHtml(container.image || '--');
                  const safeState = escapeHtml(container.state || '--');
                  const safeStatus = escapeHtml(container.status || '--');
                  return `
                    <tr>
                      <td>${safeName}</td>
                      <td>${safeImage}</td>
                      <td><span class="badge ${safeState.toLowerCase()}">${safeState}</span></td>
                      <td>${safeStatus}</td>
                      <td>
                        <button class="action-btn" data-c-action="start" data-c-name="${safeName}" ${
                    container.isRunning ? 'disabled' : ''
                  }>Start</button>
                        <button class="action-btn" data-c-action="stop" data-c-name="${safeName}" ${
                    container.isRunning ? '' : 'disabled'
                  }>Stop</button>
                        <button class="action-btn" data-c-action="logs" data-c-name="${safeName}">Logs</button>
                      </td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        `
            : 'No docker containers found for this host.'
        }
      </div>
    </article>

    <article class="panel card">
      <h3>${logsTitle}</h3>
      <pre class="logs-output">${logsContent}</pre>
    </article>
  `;
}

function renderPageHeader() {
  if (activeView.type === 'home') {
    pageKicker.textContent = 'Overview';
    pageTitle.textContent = 'Home';
    pageSubtitle.textContent = 'Global summary of all hosts';
    return;
  }

  const host = getActiveHost();
  pageKicker.textContent = 'Host';
  pageTitle.textContent = host?.name || 'Host';
  pageSubtitle.textContent = host ? `${host.username}@${host.host}:${host.port}` : 'Host not found';
}

function setView(type, hostId = null) {
  viewNonce += 1;
  activeView = type === 'host' ? { type: 'host', hostId } : { type: 'home' };
  homeBtn.classList.toggle('active', activeView.type === 'home');
  homeView.classList.toggle('hidden', activeView.type !== 'home');
  hostView.classList.toggle('hidden', activeView.type !== 'host');
  renderHostsNav();
  renderPageHeader();
}

async function apiJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.details || data.error || 'Unexpected error');
  }
  return data;
}

async function loadHosts() {
  const data = await apiJson('/api/hosts');
  hosts = data.items || [];

  if (activeView.type === 'host') {
    const stillExists = hosts.some((host) => host.id === activeView.hostId);
    if (!stillExists) {
      setView('home');
    }
  }

  renderHostsNav();
  renderPageHeader();
}

async function fetchHostSnapshot(hostId, { silent = false, reload = true } = {}) {
  try {
    await apiJson(`/api/hosts/${hostId}/fetch`, { method: 'POST' });
    if (reload) {
      await loadHosts();
    }
  } catch (error) {
    if (!silent) {
      showToast(error.message);
    }
  }
}

async function fetchHistory(hostId, range) {
  const limit = HISTORY_LIMIT_BY_RANGE[range] || 240;
  return apiJson(`/api/hosts/${hostId}/history?range=${encodeURIComponent(range)}&limit=${limit}`);
}

async function renderHomeFromApi() {
  const summary = await apiJson('/api/home/summary');
  if (activeView.type !== 'home') return;
  renderHome(summary);
}

async function renderHostFromApi(hostId, expectedNonce = viewNonce) {
  const detailPromise = apiJson(`/api/hosts/${hostId}/detail`);
  const cpuHistoryPromise = fetchHistory(hostId, cpuRange);
  const ramHistoryPromise = ramRange === cpuRange ? cpuHistoryPromise : fetchHistory(hostId, ramRange);

  const [detail, cpuHistory, ramHistory] = await Promise.all([detailPromise, cpuHistoryPromise, ramHistoryPromise]);
  if (viewNonce !== expectedNonce) return;
  if (activeView.type !== 'host' || activeView.hostId !== hostId) return;
  renderHostView(detail, cpuHistory, ramHistory);
}

async function refreshCurrentView({ silent = true } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    if (activeView.type === 'home') {
      if (hosts.length) {
        await Promise.all(hosts.map((host) => fetchHostSnapshot(host.id, { silent: true, reload: false })));
        await loadHosts();
      }
      await renderHomeFromApi();
      return;
    }

    const host = getActiveHost();
    if (!host) {
      setView('home');
      await renderHomeFromApi();
      return;
    }

    await fetchHostSnapshot(host.id, { silent: true });
    await renderHostFromApi(host.id);
  } catch (error) {
    if (!silent) {
      showToast(error.message);
    }
  } finally {
    refreshInFlight = false;
  }
}

homeBtn.addEventListener('click', async () => {
  setView('home');
  try {
    await renderHomeFromApi();
  } catch (error) {
    showToast(error.message);
  }
});

hostsNav.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const hostButton = target.closest('[data-host-id]');
  if (hostButton instanceof HTMLElement) {
    const hostId = hostButton.dataset.hostId;
    if (!hostId) return;

    hostLogsState = { containerName: '', logs: '', error: '' };
    setView('host', hostId);
    const currentNonce = viewNonce;

    try {
      await fetchHostSnapshot(hostId, { silent: true });
      await renderHostFromApi(hostId, currentNonce);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const deleteButton = target.closest('[data-del-host]');
  if (deleteButton instanceof HTMLElement) {
    const deleteId = deleteButton.dataset.delHost;
    if (!deleteId) return;

    try {
      await apiJson(`/api/hosts/${deleteId}`, { method: 'DELETE' });
      await loadHosts();

      if (activeView.type === 'home') {
        await renderHomeFromApi();
      } else {
        const activeHost = getActiveHost();
        if (activeHost) {
          await renderHostFromApi(activeHost.id);
        } else {
          setView('home');
          await renderHomeFromApi();
        }
      }

      showToast('Host removed');
    } catch (error) {
      showToast(error.message);
    }
  }
});

hostView.addEventListener('change', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.dataset.rangeType === 'cpu') {
    cpuRange = target.value;
  }
  if (target.dataset.rangeType === 'ram') {
    ramRange = target.value;
  }

  const host = getActiveHost();
  if (!host) return;

  try {
    await renderHostFromApi(host.id);
  } catch (error) {
    showToast(error.message);
  }
});

hostView.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const actionButton = target.closest('[data-c-action]');
  if (!(actionButton instanceof HTMLElement)) return;

  const action = actionButton.dataset.cAction;
  const containerName = actionButton.dataset.cName;
  if (!action || !containerName) return;

  const host = getActiveHost();
  if (!host) return;

  if (action === 'logs') {
    try {
      const data = await apiJson(`/api/hosts/${host.id}/containers/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containerName })
      });
      hostLogsState = { containerName, logs: data.logs || '', error: '' };
      await renderHostFromApi(host.id);
    } catch (error) {
      hostLogsState = { containerName, logs: '', error: error.message };
      await renderHostFromApi(host.id);
      showToast(error.message);
    }
    return;
  }

  try {
    await apiJson(`/api/hosts/${host.id}/containers/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, containerName })
    });
    await loadHosts();
    await renderHostFromApi(host.id);
    showToast(`Container ${containerName}: ${action} ok`);
  } catch (error) {
    showToast(error.message);
  }
});

toggleAddHostBtn.addEventListener('click', () => {
  addHostForm.classList.toggle('hidden');
});

addHostForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const payload = {
    name: document.getElementById('name').value.trim(),
    host: document.getElementById('host').value.trim(),
    port: Number(document.getElementById('port').value || 22),
    username: document.getElementById('username').value.trim(),
    authType: document.getElementById('authType').value
  };

  if (!payload.name || !payload.host || !payload.username) {
    showToast('Name, host and user are required');
    return;
  }

  if (payload.authType === 'password') {
    payload.password = document.getElementById('password').value;
    if (!payload.password) {
      showToast('Password is required');
      return;
    }
  } else {
    payload.privateKey = document.getElementById('privateKey').value;
    payload.passphrase = document.getElementById('passphrase').value;
    if (!payload.privateKey) {
      showToast('Private key is required');
      return;
    }
  }

  try {
    const data = await apiJson('/api/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    addHostForm.reset();
    document.getElementById('port').value = '22';
    authTypeSelect.value = 'password';
    setAuthFormMode();

    await loadHosts();
    hostLogsState = { containerName: '', logs: '', error: '' };
    setView('host', data.item.id);
    const currentNonce = viewNonce;
    await fetchHostSnapshot(data.item.id, { silent: true });
    await renderHostFromApi(data.item.id, currentNonce);
    showToast('Host created');
  } catch (error) {
    showToast(error.message);
  }
});

authTypeSelect.addEventListener('change', setAuthFormMode);

setInterval(async () => {
  await refreshCurrentView({ silent: true });
}, AUTO_REFRESH_MS);

async function bootstrap() {
  setAuthFormMode();
  await loadHosts();

  if (hosts.length) {
    hostLogsState = { containerName: '', logs: '', error: '' };
    setView('host', hosts[0].id);
    const currentNonce = viewNonce;
    await fetchHostSnapshot(hosts[0].id, { silent: true });
    await renderHostFromApi(hosts[0].id, currentNonce);
  } else {
    setView('home');
    await renderHomeFromApi();
  }
}

bootstrap().catch((error) => {
  showToast(error.message || 'Startup error');
});
