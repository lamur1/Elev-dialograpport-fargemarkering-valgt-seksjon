'use strict';

const SWATCHES_NORMAL = [
  { hex: '#ddeeff', label: 'Duggblå'      },
  { hex: '#ddf2e8', label: 'Lysgrønn'     },
  { hex: '#faebd7', label: 'Hvetebeige'   },
  { hex: '#f5e6ea', label: 'Pudderrosa'   },
  { hex: '#ede8f5', label: 'Lavendeltåke' },
  { hex: '#fdf6d3', label: 'Kremgul'      },
  { hex: '#e3f4f7', label: 'Isblå'        },
  { hex: '#e8f5e2', label: 'Eplegrønn'    },
  { hex: '#fdeee5', label: 'Aprikos'      },
  { hex: '#ebebeb', label: 'Perle'        },
];
const SWATCHES_SUBTLE = [
  { hex: '#f2f7ff', label: 'Nesten hvit – blå'  },
  { hex: '#f2faf5', label: 'Nesten hvit – grønn' },
  { hex: '#fdfaf3', label: 'Nesten hvit – gul'   },
  { hex: '#fdf5f6', label: 'Nesten hvit – rosa'  },
  { hex: '#f6f3fc', label: 'Nesten hvit – lilla' },
];

const DEFAULT_COLOR = SWATCHES_NORMAL[0].hex;
const DEFAULTS = {
  enabled:           true,
  overrideSectionId: null,
  highlightColor:    DEFAULT_COLOR,
  autoSort:          true,
};

const toggleEl       = document.getElementById('toggle-enabled');
const toggleText     = document.getElementById('toggle-text');
const autoSortEl     = document.getElementById('toggle-autosort');
const settingsEl     = document.getElementById('settings-body');
const autoCard       = document.getElementById('auto-card');
const autoDot        = document.getElementById('auto-dot');
const autoNameEl     = document.getElementById('auto-name');
const selectEl       = document.getElementById('section-select');
const resetBtn       = document.getElementById('reset-override');
const refreshBtn     = document.getElementById('btn-refresh');
const swatchesNormal = document.getElementById('swatches-normal');
const swatchesSubtle = document.getElementById('swatches-subtle');

let currentOverride = null;
let currentColor    = DEFAULT_COLOR;

// ─── Bygg swatches ───────────────────────────────────────────────────────────
function buildSwatches(container, list) {
  list.forEach(({ hex, label }) => {
    const btn = document.createElement('button');
    btn.className        = 'swatch';
    btn.title            = label;
    btn.dataset.hex      = hex;
    btn.style.background = hex;
    btn.addEventListener('click', () => selectColor(hex));
    container.appendChild(btn);
  });
}
buildSwatches(swatchesNormal, SWATCHES_NORMAL);
buildSwatches(swatchesSubtle, SWATCHES_SUBTLE);

function selectColor(hex) {
  currentColor = hex;
  document.querySelectorAll('.swatch').forEach(b =>
    b.classList.toggle('active', b.dataset.hex === hex)
  );
  autoDot.style.background   = hex;
  autoCard.style.borderColor = hex;
  save({ highlightColor: hex });
}

// ─── Last innstillinger ──────────────────────────────────────────────────────
chrome.storage.local.get(DEFAULTS, (cfg) => {
  toggleEl.checked       = cfg.enabled !== false;
  toggleText.textContent = cfg.enabled !== false ? 'På' : 'Av';
  autoSortEl.checked     = cfg.autoSort !== false;
  setBodyEnabled(cfg.enabled !== false);
  currentOverride = cfg.overrideSectionId || null;
  selectColor(cfg.highlightColor || DEFAULT_COLOR);
  askContentScript(cfg.overrideSectionId);
});

// ─── Hent seksjonsdata fra content script ────────────────────────────────────
function askContentScript(overrideId, attempt) {
  attempt = attempt || 1;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !/\/users\/\d+\/teacher_activity\/course\/\d+/.test(tab.url || '')) {
      showNotOnPage(); return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'CDS_GET_DATA' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        if (attempt < 10) setTimeout(() => askContentScript(overrideId, attempt + 1), 700);
        else showNotOnPage();
        return;
      }
      renderAutoCard(response.autoSectionId, response.autoSectionName);
      if (response.sections.length > 0) {
        populateSections(response.sections, overrideId, response.autoSectionId);
      } else if (attempt < 10) {
        setTimeout(() => askContentScript(overrideId, attempt + 1), 700);
      }
    });
  });
}

function showNotOnPage() {
  autoNameEl.textContent = 'Åpne Dialograpport-siden først';
  autoNameEl.className   = 'auto-name loading';
  selectEl.innerHTML     = '<option value="">— Åpne Dialograpport-siden først —</option>';
  selectEl.disabled      = true;
}

function renderAutoCard(sectionId, name) {
  autoDot.style.background   = currentColor;
  autoCard.style.borderColor = currentColor;
  if (sectionId && name) {
    autoNameEl.textContent = name;
    autoNameEl.className   = 'auto-name';
  } else {
    autoNameEl.textContent = 'Ikke funnet – velg manuelt';
    autoNameEl.className   = 'auto-name loading';
  }
}

function populateSections(sections, overrideId, autoId) {
  selectEl.innerHTML = '';
  selectEl.disabled  = false;

  const blank = document.createElement('option');
  blank.value       = '';
  blank.textContent = '— Min seksjon (automatisk) —';
  selectEl.appendChild(blank);

  sections.forEach(sec => {
    const opt = document.createElement('option');
    opt.value       = sec.id;
    opt.textContent = sec.name + (sec.id === String(autoId) ? ' ★' : '');
    if (String(sec.id) === String(overrideId)) opt.selected = true;
    selectEl.appendChild(opt);
  });

  updateResetLink();
}

function updateResetLink() {
  resetBtn.classList.toggle('visible', !!currentOverride);
}

// ─── Hendelser ───────────────────────────────────────────────────────────────
toggleEl.addEventListener('change', () => {
  const enabled = toggleEl.checked;
  toggleText.textContent = enabled ? 'På' : 'Av';
  setBodyEnabled(enabled);
  save({ enabled });
});

autoSortEl.addEventListener('change', () => {
  save({ autoSort: autoSortEl.checked });
});

selectEl.addEventListener('change', () => {
  currentOverride = selectEl.value || null;
  save({ overrideSectionId: currentOverride });
  updateResetLink();
});

resetBtn.addEventListener('click', () => {
  currentOverride = null;
  selectEl.value  = '';
  save({ overrideSectionId: null });
  updateResetLink();
});

refreshBtn.addEventListener('click', () => {
  chrome.storage.local.get(null, (all) => {
    const keys = Object.keys(all).filter(k => k.startsWith('cds_'));
    chrome.storage.local.remove(keys, () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) { chrome.tabs.reload(tabs[0].id); window.close(); }
      });
    });
  });
});

function save(changes) { chrome.storage.local.set(changes); }

function setBodyEnabled(enabled) {
  settingsEl.classList.toggle('disabled-overlay', !enabled);
}
