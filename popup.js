'use strict';

// ─── Fargepaletten ────────────────────────────────────────────────────────────
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
const DEFAULTS = { enabled: true, overrideSectionId: null, highlightColor: DEFAULT_COLOR };

// ─── Element-referanser ───────────────────────────────────────────────────────
const toggleEl       = document.getElementById('toggle-enabled');
const toggleText     = document.getElementById('toggle-text');
const settingsEl     = document.getElementById('settings-body');
const autoCard       = document.getElementById('auto-card');
const autoDot        = document.getElementById('auto-dot');
const autoName       = document.getElementById('auto-name');
const selectEl       = document.getElementById('section-select');
const resetBtn       = document.getElementById('reset-override');
const refreshBtn     = document.getElementById('btn-refresh');
const swatchesNormal = document.getElementById('swatches-normal');
const swatchesSubtle = document.getElementById('swatches-subtle');

let currentOverride = null;
let currentColor    = DEFAULT_COLOR;
let sectionsLoaded  = false;

// ─── Bygg fargeswatch-grids ───────────────────────────────────────────────────
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

// ─── Last inn innstillinger og sett opp lytter ───────────────────────────────
chrome.storage.local.get(DEFAULTS, (cfg) => {
  const enabled = cfg.enabled !== false;
  toggleEl.checked       = enabled;
  toggleText.textContent = enabled ? 'På' : 'Av';
  setBodyEnabled(enabled);

  currentOverride = cfg.overrideSectionId || null;
  selectColor(cfg.highlightColor || DEFAULT_COLOR);

  // Forsøk å hente seksjonsdata med én gang
  tryLoadPopupData(cfg.overrideSectionId);
});

// Lytt på storage-endringer: content-scriptet publiserer cds_popup når det er
// ferdig. Da oppdaterer vi dropdown uansett om popup var åpen allerede.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.cds_popup && !sectionsLoaded) {
    const data = changes.cds_popup.newValue;
    if (data) applyPopupData(data, currentOverride);
  }
  // Oppdater farge live dersom endringen kom fra en annen kilde
  if (changes.highlightColor) {
    selectColor(changes.highlightColor.newValue);
  }
});

// ─── Hent popup-data (en gang; resten håndteres av storage-lytteren) ─────────
function tryLoadPopupData(overrideId) {
  chrome.storage.local.get('cds_popup', (r) => {
    if (r.cds_popup && r.cds_popup.sections && r.cds_popup.sections.length > 0) {
      applyPopupData(r.cds_popup, overrideId);
    } else {
      // Data ikke klar ennå – vis ventemodus, storage-lytteren tar over
      autoName.textContent = 'Åpne Dialograpport-siden…';
      autoName.className   = 'auto-name loading';
      selectEl.innerHTML   = '<option value="">— Laster seksjoner… —</option>';
      selectEl.disabled    = true;
    }
  });
}

function applyPopupData(data, overrideId) {
  sectionsLoaded = true;
  renderAutoCard(data.autoSectionId, data.autoSectionName, currentColor);
  populateSections(data.sections || [], overrideId, data.autoSectionId);
}

// ─── Auto-kort ────────────────────────────────────────────────────────────────
function renderAutoCard(sectionId, name, color) {
  autoDot.style.background   = color;
  autoCard.style.borderColor = color;
  if (sectionId && name) {
    autoName.textContent = name;
    autoName.className   = 'auto-name';
  } else {
    autoName.textContent = 'Ikke funnet – velg manuelt';
    autoName.className   = 'auto-name loading';
  }
}

// ─── Seksjonsdropdown ─────────────────────────────────────────────────────────
function populateSections(sections, overrideId, autoId) {
  selectEl.innerHTML = '';
  selectEl.disabled  = sections.length === 0;

  if (sections.length === 0) {
    selectEl.innerHTML = '<option value="">— Ingen seksjoner funnet —</option>';
    return;
  }

  const autoOpt = document.createElement('option');
  autoOpt.value       = '';
  autoOpt.textContent = '— Min seksjon (automatisk) —';
  selectEl.appendChild(autoOpt);

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

// ─── Hendelser ────────────────────────────────────────────────────────────────
toggleEl.addEventListener('change', () => {
  const enabled = toggleEl.checked;
  toggleText.textContent = enabled ? 'På' : 'Av';
  setBodyEnabled(enabled);
  save({ enabled });
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

// ─── Hjelpere ─────────────────────────────────────────────────────────────────
function save(changes) { chrome.storage.local.set(changes); }

function setBodyEnabled(enabled) {
  settingsEl.classList.toggle('disabled-overlay', !enabled);
}
