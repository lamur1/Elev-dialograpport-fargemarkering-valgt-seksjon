(function () {
  'use strict';

  if (!/\/users\/\d+\/teacher_activity\/course\/\d+/.test(location.pathname)) return;

  const DEFAULTS = {
    enabled:           true,
    overrideSectionId: null,
    highlightColor:    '#ddeeff',
    autoSort:          true,
  };

  let cfg               = { ...DEFAULTS };
  let allSections       = [];
  let autoSectionId     = null;
  let activeSectionId   = null;
  let activeColor       = DEFAULTS.highlightColor;
  let sectionStudentIds = new Set();
  let ready             = false;
  let sortDone          = false;
  let isSorting         = false;
  let mutationObserver  = null; // lagres slik at vi kan koble fra under sortering

  // ─── Start ──────────────────────────────────────────────────────────────────
  chrome.storage.local.get(DEFAULTS, (saved) => {
    cfg = { ...DEFAULTS, ...saved };
    init();
  });

  chrome.storage.local.onChanged.addListener((changes) => {
    const hadAutoSort = cfg.autoSort;
    for (const key in changes) cfg[key] = changes[key].newValue;
    resolveActiveSection();
    applyHighlights();
    if (!hadAutoSort && cfg.autoSort && !sortDone) {
      setTimeout(() => triggerSort(() => {
        applyHighlights();
        if (!mutationObserver) observeForChanges();
      }), 300);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === 'CDS_GET_DATA') {
      respond({
        ready,
        autoSectionId,
        autoSectionName: nameForId(autoSectionId),
        sections: allSections.map(s => ({ id: s.id, name: s.name })),
      });
      return true;
    }
  });

  // ─── Init ────────────────────────────────────────────────────────────────────
  async function init() {
    const courseId = getCourseId();
    if (!courseId) return;
    await Promise.all([
      fetchSections(courseId),
      fetchTeacherSection(courseId),
    ]);
    ready = true;
    resolveActiveSection();
    waitForTable();
  }

  // ─── Hent seksjoner ──────────────────────────────────────────────────────────
  async function fetchSections(courseId) {
    const cacheKey = `cds_sections_${courseId}`;
    const maxAge   = 30 * 60 * 1000;
    try {
      const cached = await localGet(cacheKey);
      if (cached && (Date.now() - cached.ts) < maxAge) { allSections = cached.sections; return; }
    } catch (e) {}
    try {
      const raw = await paginate(
        `/api/v1/courses/${courseId}/sections?include[]=students&per_page=100`
      );
      allSections = raw.map(s => ({
        id:       String(s.id),
        name:     s.name,
        students: (s.students || []).map(st => ({
          id:   String(st.id),
          name: st.sortable_name || st.name || ''
        }))
      }));
      chrome.storage.local.set({ [cacheKey]: { ts: Date.now(), sections: allSections } });
    } catch (e) { console.warn('[Seksjonsmarkering] fetchSections:', e); }
  }

  // ─── Auto-detekter lærers seksjon ────────────────────────────────────────────
  async function fetchTeacherSection(courseId) {
    const cacheKey = `cds_teacher_${courseId}`;
    const maxAge   = 60 * 60 * 1000;
    try {
      const cached = await localGet(cacheKey);
      if (cached && (Date.now() - cached.ts) < maxAge) { autoSectionId = cached.sectionId; return; }
    } catch (e) {}
    try {
      const me = await apiFetch('/api/v1/users/self');
      if (!me?.id) return;
      const enrollments = await paginate(
        `/api/v1/courses/${courseId}/enrollments` +
        `?user_id=${me.id}&type[]=TeacherEnrollment&per_page=100`
      );
      if (enrollments.length > 0) {
        autoSectionId = String(enrollments[0].course_section_id);
        chrome.storage.local.set({ [cacheKey]: { ts: Date.now(), sectionId: autoSectionId } });
      }
    } catch (e) { console.warn('[Seksjonsmarkering] fetchTeacherSection:', e); }
  }

  // ─── Aktiv seksjon ───────────────────────────────────────────────────────────
  function resolveActiveSection() {
    activeSectionId = cfg.overrideSectionId
      ? String(cfg.overrideSectionId)
      : autoSectionId;
    activeColor = cfg.highlightColor || DEFAULTS.highlightColor;
    sectionStudentIds.clear();
    if (activeSectionId) {
      const sec = allSections.find(s => s.id === activeSectionId);
      if (sec) sec.students.forEach(st => sectionStudentIds.add(st.id));
    }
  }

  // ─── Vent på tabell OG TableSorter-initialisering ───────────────────────────
  function waitForTable() {
    const deadline = Date.now() + 20_000;
    const tick = () => {
      const rows   = getStudentRows();
      const header = getTargetColumnHeader();
      const tsReady = header && header.classList.contains('tablesorter-header');
      if (rows.length > 0 && tsReady) {
        // Vis farger med én gang, uavhengig av om sortering er ferdig
        applyHighlights();
        if (cfg.autoSort && !sortDone) {
          triggerSort(() => {
            applyHighlights();
            observeForChanges();
          });
        } else {
          observeForChanges();
        }
      } else if (Date.now() < deadline) {
        setTimeout(tick, 400);
      }
    };
    tick();
  }

  // ─── Auto-sortering ──────────────────────────────────────────────────────────
  function triggerSort(callback) {
    if (sortDone || isSorting) { if (callback) callback(); return; }
    isSorting = true;

    // Koble fra MutationObserveren så den ikke forstyrrer under sorteringen
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    const colIndex = getTargetColumnIndex();
    if (colIndex === -1) {
      isSorting = false;
      if (callback) callback();
      return;
    }

    injectPageSort(colIndex, 1, () => {
      sortDone  = true;
      isSorting = false;
      if (callback) callback();
    });
  }

  // Injiser sorter.js i sidens kontekst via <script src>
  // Venter på cds-sort-done-eventet fra sorter.js (ikke script.onload)
  // slik at callback først kjøres når begge klikk er bekreftet ferdige.
  function injectPageSort(col, dir, callback) {
    const trigger = document.createElement('div');
    trigger.id = 'cds-sort-trigger';
    trigger.setAttribute('data-col', col);
    trigger.setAttribute('data-dir', dir);
    trigger.style.display = 'none';
    document.body.appendChild(trigger);

    function onSortDone() {
      document.removeEventListener('cds-sort-done', onSortDone);
      if (callback) callback();
    }
    document.addEventListener('cds-sort-done', onSortDone);

    const script  = document.createElement('script');
    script.src    = chrome.runtime.getURL('sorter.js');
    script.onload = () => script.remove();
    script.onerror = () => {
      script.remove();
      trigger.remove();
      document.removeEventListener('cds-sort-done', onSortDone);
      if (callback) callback();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // Finn kolonneoverskriften for «Ikke vurderte oppgaver»
  function getTargetColumnHeader() {
    const allHeaders = document.querySelectorAll('table thead th, table th');
    for (const th of allHeaders) {
      const inner = th.querySelector('.tablesorter-header-inner');
      const text  = (inner ? inner.textContent : th.textContent).trim();
      if (text === 'Ikke vurderte oppgaver') return th;
    }
    return null;
  }

  // Finn data-column-indeksen TableSorter bruker for kolonnen
  function getTargetColumnIndex() {
    const header = getTargetColumnHeader();
    if (!header) return -1;
    const dataCol = header.getAttribute('data-column');
    if (dataCol !== null) return parseInt(dataCol, 10);
    const siblings = Array.from(header.parentElement.children);
    return siblings.indexOf(header);
  }

  // ─── Fargemarkering ──────────────────────────────────────────────────────────
  function getStudentRows() {
    return Array.from(document.querySelectorAll('table tr')).filter(row =>
      !row.querySelector('th') &&
      row.querySelectorAll('td').length >= 1 &&
      row.querySelector('td a')
    );
  }

  function applyHighlights() {
    if (isSorting) return;
    getStudentRows().forEach(row => {
      row.style.backgroundColor = '';
      row.style.transition      = '';
      if (!cfg.enabled || !activeSectionId) return;
      const sid = extractStudentId(row);
      if (sid && sectionStudentIds.has(sid)) {
        row.style.transition      = 'background-color 0.2s';
        row.style.backgroundColor = activeColor;
      }
    });
  }

  function extractStudentId(row) {
    const a1 = row.querySelector('[data-student-id]');
    if (a1) return String(a1.dataset.studentId);
    const a2 = row.querySelector('a[href*="/users/"]');
    if (a2) { const m = a2.href.match(/\/users\/(\d+)/); if (m) return m[1]; }
    const a3 = row.querySelector('a[href*="student_id="]');
    if (a3) { const m = a3.href.match(/[?&]student_id=(\d+)/); if (m) return m[1]; }
    const rid = row.dataset.id || row.dataset.userId || row.dataset.studentId;
    if (rid) return String(rid);
    const nameEl = row.querySelector('td:first-child');
    if (nameEl) return findIdByName(nameEl.textContent.trim());
    return null;
  }

  function findIdByName(name) {
    for (const sec of allSections)
      for (const st of sec.students)
        if (st.name.trim() === name) return st.id;
    return null;
  }

  // ─── Observer – farger etter DOM-endringer ────────────────────────────────
  function observeForChanges() {
    let debounce = null;
    mutationObserver = new MutationObserver(() => {
      if (isSorting) return;
      clearTimeout(debounce);
      debounce = setTimeout(applyHighlights, 150);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    function attachHeaderListeners() {
      document.querySelectorAll('table th, [role="columnheader"]').forEach(th => {
        if (th.dataset.cdsListener) return;
        th.dataset.cdsListener = '1';
        th.addEventListener('click', () => {
          if (isSorting) return;
          setTimeout(applyHighlights, 200);
          setTimeout(applyHighlights, 600);
          setTimeout(applyHighlights, 1200);
        });
      });
    }
    attachHeaderListeners();
    setTimeout(attachHeaderListeners, 2000);
  }

  // ─── Hjelpere ────────────────────────────────────────────────────────────────
  function nameForId(id) {
    if (!id) return null;
    const sec = allSections.find(s => s.id === String(id));
    return sec ? sec.name : null;
  }

  function getCourseId() {
    const m = location.pathname.match(/\/teacher_activity\/course\/(\d+)/);
    return m ? m[1] : null;
  }

  async function apiFetch(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`${resp.status} ${url}`);
    return resp.json();
  }

  async function paginate(url) {
    let results = [], next = url;
    while (next) {
      const resp = await fetch(next, { credentials: 'include' });
      if (!resp.ok) break;
      results = results.concat(await resp.json());
      const m = (resp.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
      next = m ? m[1] : null;
    }
    return results;
  }

  function localGet(key) {
    return new Promise(res => chrome.storage.local.get(key, r => res(r[key])));
  }

})();
