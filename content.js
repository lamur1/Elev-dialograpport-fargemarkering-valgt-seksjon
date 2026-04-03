(function () {
  'use strict';

  // Bare kjør på Dialograpport-siden
  if (!/\/users\/\d+\/teacher_activity\/course\/\d+/.test(location.pathname)) return;

  // ─── Standardverdier ──────────────────────────────────────────────────────
  const DEFAULTS = {
    enabled:           true,
    overrideSectionId: null,
    highlightColor:    '#ddeeff',
  };

  let cfg           = { ...DEFAULTS };
  let allSections   = [];              // [{id, name, students:[{id,name}]}]
  let autoSectionId = null;            // Lærers egen seksjon fra API
  let activeSectionId = null;          // Faktisk aktiv (override ?? auto)
  let activeColor     = DEFAULTS.highlightColor;
  let sectionStudentIds = new Set();

  // ─── Start ────────────────────────────────────────────────────────────────
  chrome.storage.local.get(DEFAULTS, (saved) => {
    cfg = { ...DEFAULTS, ...saved };
    init();
  });

  chrome.storage.onChanged.addListener((changes) => {
    for (const key in changes) cfg[key] = changes[key].newValue;
    resolveActiveSection();
    applyHighlights();
  });

  // ─── Initialisering ───────────────────────────────────────────────────────
  async function init() {
    const courseId = getCourseId();
    if (!courseId) return;

    await Promise.all([
      fetchSections(courseId),
      fetchTeacherSection(courseId),
    ]);

    resolveActiveSection();
    publishToPopup();
    waitForTable();
  }

  // ─── Hent alle seksjoner i kurset ────────────────────────────────────────
  async function fetchSections(courseId) {
    const cacheKey = `cds_sections_${courseId}`;
    const maxAge   = 30 * 60 * 1000;

    try {
      const cached = await localGet(cacheKey);
      if (cached && (Date.now() - cached.ts) < maxAge) {
        allSections = cached.sections;
        return;
      }
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
      chrome.storage.local.set({
        [cacheKey]: { ts: Date.now(), sections: allSections }
      });
    } catch (e) {
      console.warn('[Seksjonsmarkering] Kunne ikke hente seksjoner:', e);
    }
  }

  // ─── Auto-detekter lærers egen seksjon ───────────────────────────────────
  async function fetchTeacherSection(courseId) {
    const cacheKey = `cds_teacher_section_${courseId}`;
    const maxAge   = 60 * 60 * 1000; // 1 time

    try {
      const cached = await localGet(cacheKey);
      if (cached && (Date.now() - cached.ts) < maxAge) {
        autoSectionId = cached.sectionId;
        return;
      }
    } catch (e) {}

    try {
      // Steg 1: finn lærers egen user_id
      const me = await apiFetch('/api/v1/users/self');
      if (!me || !me.id) return;

      // Steg 2: finn lærerens enrollments i dette kurset
      const enrollments = await paginate(
        `/api/v1/courses/${courseId}/enrollments` +
        `?user_id=${me.id}&type[]=TeacherEnrollment&per_page=100`
      );

      if (enrollments.length > 0) {
        // Bruk første treff (vanligvis bare én seksjon per lærer)
        autoSectionId = String(enrollments[0].course_section_id);
        chrome.storage.local.set({
          [cacheKey]: { ts: Date.now(), sectionId: autoSectionId }
        });
      }
    } catch (e) {
      console.warn('[Seksjonsmarkering] Kunne ikke auto-detektere seksjon:', e);
    }
  }

  // ─── Finn aktiv seksjon (override > auto) ────────────────────────────────
  function resolveActiveSection() {
    activeSectionId = cfg.overrideSectionId
      ? String(cfg.overrideSectionId)
      : autoSectionId;

    activeColor = cfg.highlightColor || DEFAULTS.highlightColor;

    // Bygg opp student-ID-settet for aktiv seksjon
    sectionStudentIds.clear();
    if (activeSectionId) {
      const sec = allSections.find(s => s.id === activeSectionId);
      if (sec) sec.students.forEach(st => sectionStudentIds.add(st.id));
    }
  }

  // ─── Send info til popup ──────────────────────────────────────────────────
  function publishToPopup() {
    chrome.storage.local.set({
      cds_popup: {
        autoSectionId,
        autoSectionName: nameForId(autoSectionId),
        autoColor:       autoSectionId ? colorForSection(autoSectionId) : null,
        sections:        allSections.map(s => ({ id: s.id, name: s.name })),
      }
    });
  }

  function nameForId(id) {
    if (!id) return null;
    const sec = allSections.find(s => s.id === String(id));
    return sec ? sec.name : null;
  }

  // ─── Vent på at tabellen er klar ──────────────────────────────────────────
  function waitForTable() {
    const deadline = Date.now() + 20_000;
    const tick = () => {
      if (getStudentRows().length > 0) {
        applyHighlights();
        observeForChanges();
      } else if (Date.now() < deadline) {
        setTimeout(tick, 600);
      }
    };
    tick();
  }

  // ─── Elevrader ────────────────────────────────────────────────────────────
  function getStudentRows() {
    return Array.from(document.querySelectorAll('table tr')).filter(row => {
      if (row.querySelector('th')) return false;
      return row.querySelectorAll('td').length >= 1 && row.querySelector('td a');
    });
  }

  // ─── Fargemarkering ───────────────────────────────────────────────────────
  function applyHighlights() {
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

  // ─── Trekk ut student-ID fra rad ─────────────────────────────────────────
  function extractStudentId(row) {
    const withAttr = row.querySelector('[data-student-id]');
    if (withAttr) return String(withAttr.dataset.studentId);

    const userLink = row.querySelector('a[href*="/users/"]');
    if (userLink) {
      const m = userLink.href.match(/\/users\/(\d+)/);
      if (m) return m[1];
    }

    const qLink = row.querySelector('a[href*="student_id="]');
    if (qLink) {
      const m = qLink.href.match(/[?&]student_id=(\d+)/);
      if (m) return m[1];
    }

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

  // ─── Observer ─────────────────────────────────────────────────────────────
  function observeForChanges() {
    let debounce = null;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(applyHighlights, 150);
    }).observe(document.body, { childList: true, subtree: true });

    function attachHeaderListeners() {
      document.querySelectorAll('table th, table [role="columnheader"]').forEach(th => {
        if (th.dataset.cdsListener) return;
        th.dataset.cdsListener = '1';
        th.addEventListener('click', () => {
          setTimeout(applyHighlights, 200);
          setTimeout(applyHighlights, 600);
          setTimeout(applyHighlights, 1200);
        });
      });
    }
    attachHeaderListeners();
    setTimeout(attachHeaderListeners, 2000);
  }

  // ─── Hjelpefunksjoner ─────────────────────────────────────────────────────
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
