(function () {
  var trigger = document.getElementById('cds-sort-trigger');
  if (!trigger) return;
  trigger.remove();

  var jq = window.jQuery || window.$;
  if (!jq) return;

  var header = null;
  var ths = document.querySelectorAll('table thead th');
  for (var i = 0; i < ths.length; i++) {
    var inner = ths[i].querySelector('.tablesorter-header-inner');
    if (inner && inner.textContent.trim() === 'Ikke vurderte oppgaver') {
      header = ths[i];
      break;
    }
  }

  function signalDone() {
    document.dispatchEvent(new CustomEvent('cds-sort-done'));
  }

  if (!header) { signalDone(); return; }

  // Kolonnen har standard synkende retning i Canvas sin TableSorter-konfig.
  // Første klikk gir derfor synkende (flest dager øverst) – det vi vil ha.
  // Andre klikk ville snudd til stigende – feil.
  jq(header).trigger('click');

  // Poll inntil tablesorter-headerDesc bekrefter at sorteringen satt,
  // send deretter cds-sort-done så content.js kan starte highlights.
  var polls = 0;
  var poll = setInterval(function () {
    polls++;
    if (header.classList.contains('tablesorter-headerDesc') || polls > 40) {
      clearInterval(poll);
      signalDone();
    }
  }, 100);
})();
