/** Entry point: theme, file loading, drag/drop, tab nav. */
import { initTheme } from './theme.js';
import { parseProfile } from './profileParser.js';
import { renderOverview } from './overviewRender.js';
import { renderScans } from './scansRender.js';
import { renderOperators } from './operatorsRender.js';
import { renderPlan, refreshPlanView } from './planRender.js';

let currentProfile = null;

function showError(message) {
  const zone = document.getElementById('dropZone');
  let banner = document.getElementById('loadError');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'loadError';
    banner.className = 'load-error';
    zone.parentElement.insertBefore(banner, zone.nextSibling);
  }
  banner.textContent = `⚠️ ${message}`;
}

function loadCSVText(text) {
  let profile;
  try {
    profile = parseProfile(text);
  } catch (err) {
    showError(`Could not parse profile: ${err.message}`);
    return;
  }
  currentProfile = profile;
  document.getElementById('loadError')?.remove();
  // Reveal dashboards, hide drop zone
  document.getElementById('dropZone').style.display = 'none';
  const overviewDash = document.getElementById('overviewDashboard');
  overviewDash.classList.add('visible');
  renderOverview(currentProfile, overviewDash);

  const scansDash = document.getElementById('scansDashboard');
  scansDash.classList.add('visible');
  renderScans(currentProfile, scansDash);

  const operatorsDash = document.getElementById('operatorsDashboard');
  operatorsDash.classList.add('visible');
  renderOperators(currentProfile, operatorsDash);

  renderPlan(currentProfile, document.getElementById('planRoot'));
}

function loadFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => loadCSVText(e.target.result);
  reader.readAsText(file);
}

function wireFileInputs() {
  const dropZone = document.getElementById('dropZone');
  const dropInput = document.getElementById('dropFileInput');
  const globalInput = document.getElementById('globalFileInput');
  const globalBtn = document.getElementById('globalLoadBtn');

  // Click drop zone → open file picker.
  // The input lives inside the zone, so dropInput.click() dispatches a click that
  // bubbles back here — ignore that re-entry, else two file dialogs open.
  dropZone.addEventListener('click', e => {
    if (e.target === dropInput) return;
    dropInput.click();
  });
  dropInput.addEventListener('change', e => loadFile(e.target.files[0]));

  // Header "Load Profile" button
  globalBtn.addEventListener('click', () => globalInput.click());
  globalInput.addEventListener('change', e => loadFile(e.target.files[0]));

  // Drag & drop (whole window, but only highlight the zone)
  ['dragenter', 'dragover'].forEach(ev =>
    window.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach(ev =>
    window.addEventListener(ev, e => {
      e.preventDefault();
      if (ev === 'drop' || e.target === dropZone) dropZone.classList.remove('drag-over');
    })
  );
  window.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });
}

function wireTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');
      // The Plan canvas computes layout from its container size; recompute the
      // fit now that the (previously hidden) panel has real dimensions.
      if (btn.dataset.tab === 'plan') refreshPlanView();
    });
  });
}

initTheme();
wireFileInputs();
wireTabs();

// Dev convenience: ?profile=test_profiles/foo.csv auto-loads a local profile,
// and #tab=operators selects a tab (used for fast iteration / screenshots).
const devProfile = new URLSearchParams(location.search).get('profile');
if (devProfile) {
  fetch(devProfile)
    .then(r => r.ok ? r.text() : Promise.reject(new Error(`${r.status} fetching ${devProfile}`)))
    .then(loadCSVText)
    .then(() => {
      const tab = new URLSearchParams(location.search).get('tab');
      if (tab) document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.click();
    })
    .catch(err => console.warn('Auto-load failed:', err.message));
}
