(() => {
  const formCard = document.getElementById('formCard');
  const statusCard = document.getElementById('statusCard');
  const reviewCard = document.getElementById('reviewCard');
  const resultCard = document.getElementById('resultCard');
  const errorCard = document.getElementById('errorCard');

  const pullForm = document.getElementById('pullForm');
  const platformSel = document.getElementById('platform');
  const last4Field = document.getElementById('last4Field');

  const itemsTbody = document.getElementById('itemsTbody');
  const itemsCountEl = document.getElementById('itemsCount');
  const piTbody = document.getElementById('piTbody');
  const piCountEl = document.getElementById('piCount');
  const reviewLede = document.getElementById('reviewLede');
  const scoreRow = document.getElementById('scoreRow');

  const generateBtn = document.getElementById('generateBtn');
  const backToFormBtn = document.getElementById('backToFormBtn');
  const newClientBtn = document.getElementById('newClientBtn');
  const letterLinks = document.getElementById('letterLinks');
  const resultLede = document.getElementById('resultLede');
  const errorBody = document.getElementById('errorBody');
  const errorReset = document.getElementById('errorReset');

  const state = {
    clientSlug: '',
    disputables: [],
    personalInfoCandidates: [],
    accountReasons: [],
    personalInfoReasons: [],
    bureauContacts: {},
  };

  const FIELD_LABELS = {
    currentAddress: 'Current address',
    previousAddress: 'Previous address',
    name: 'Name',
    employer: 'Employer',
    phone: 'Phone',
    ssn: 'SSN',
    birthYear: 'Birth year',
  };

  function show(card) {
    [formCard, statusCard, reviewCard, resultCard, errorCard].forEach((c) => c.classList.add('hidden'));
    card.classList.remove('hidden');
  }

  platformSel.addEventListener('change', () => {
    last4Field.style.display = platformSel.value === 'iiq' ? 'flex' : 'none';
  });

  async function loadReasons() {
    try {
      const r = await fetch('/api/reasons');
      const j = await r.json();
      state.accountReasons = j.accountReasons || [];
      state.personalInfoReasons = j.personalInfoReasons || [];
      state.bureauContacts = j.bureauContacts || {};
    } catch (e) {
      console.warn('Failed to load reasons', e);
    }
  }

  loadReasons();

  pullForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(pullForm));
    data.headed = pullForm.querySelector('#headed').checked;

    show(statusCard);

    try {
      const resp = await fetch('/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await resp.json();

      if (!json.ok) {
        errorBody.textContent =
          (json.error || 'Sweep could not pull the report.') +
          (json.stage ? `  (stage: ${json.stage})` : '');
        show(errorCard);
        return;
      }

      state.clientSlug = json.clientSlug || 'client';
      state.capturedReportPath = json.capturedReportPath || null;
      state.disputables = json.disputables || [];
      state.personalInfoCandidates = json.personalInfoCandidates || [];

      prefillClientForm(json.prefilledClient || {});
      renderScoreRow(json.report);
      renderItemsTable();
      renderPiTable();

      const itemCount = state.disputables.length;
      reviewLede.textContent = itemCount
        ? `Sweep flagged ${itemCount} disputable item${itemCount === 1 ? '' : 's'} across the three bureaus. Pick reasons, review the personal info section, then generate.`
        : 'No negative items flagged on this report. You can still dispute personal info or skip and pull a different report.';

      show(reviewCard);
    } catch (err) {
      errorBody.textContent = err?.message || String(err);
      show(errorCard);
    }
  });

  function prefillClientForm(pc) {
    document.getElementById('ci_fullName').value = pc.fullName || '';
    document.getElementById('ci_address').value = pc.address || '';
    document.getElementById('ci_cityStateZip').value = pc.cityStateZip || '';
    document.getElementById('ci_dob').value = pc.dob || '';
    document.getElementById('ci_ssnLast4').value = pc.ssnLast4 || '';
    document.getElementById('ci_letterDate').value = '';
  }

  function renderScoreRow(report) {
    if (!report?.scores) {
      scoreRow.innerHTML = '';
      return;
    }
    const s = report.scores;
    scoreRow.innerHTML = `
      <div class="stat"><div class="stat-num">${s.equifax ?? '—'}</div><div class="stat-label">Equifax</div></div>
      <div class="stat"><div class="stat-num">${s.experian ?? '—'}</div><div class="stat-label">Experian</div></div>
      <div class="stat"><div class="stat-num">${s.transunion ?? '—'}</div><div class="stat-label">TransUnion</div></div>
    `;
  }

  function reasonSelectHtml(idPrefix, reasons, defaultId) {
    const opts = reasons
      .map((r) => `<option value="${r.id}"${r.id === defaultId ? ' selected' : ''}>${escapeHtml(r.label)}</option>`)
      .join('');
    return `
      <select class="reason-select" data-itemid="${idPrefix}">
        ${opts}
        <option value="__custom__">Write my own…</option>
      </select>
      <input type="text" class="reason-custom hidden" data-itemid="${idPrefix}" placeholder="Custom reason text" />
    `;
  }

  function renderItemsTable() {
    itemsCountEl.textContent = String(state.disputables.length);
    if (state.disputables.length === 0) {
      itemsTbody.innerHTML = '<tr><td colspan="4" class="empty">No negative items flagged.</td></tr>';
      return;
    }
    const defaultReason = state.accountReasons[0]?.id || '';
    itemsTbody.innerHTML = state.disputables.map((item) => {
      const bureauLabel = state.bureauContacts[item.bureau]?.displayName || cap(item.bureau);
      return `
        <tr data-id="${item.id}">
          <td class="cb-col"><input type="checkbox" class="item-check" data-itemid="${item.id}" checked /></td>
          <td>
            <div class="cell-creditor">${escapeHtml(item.creditor)}</div>
            <div class="cell-detail">${escapeHtml(item.detail || '')}</div>
          </td>
          <td class="bureau-col">${escapeHtml(bureauLabel)}</td>
          <td>${reasonSelectHtml(item.id, state.accountReasons, defaultReason)}</td>
        </tr>
      `;
    }).join('');
    wireReasonSelects(itemsTbody);
  }

  function renderPiTable() {
    piCountEl.textContent = String(state.personalInfoCandidates.length);
    if (state.personalInfoCandidates.length === 0) {
      piTbody.innerHTML = '<tr><td colspan="5" class="empty">No personal info entries found on this report.</td></tr>';
      return;
    }
    const defaultReason = state.personalInfoReasons[0]?.id || '';
    piTbody.innerHTML = state.personalInfoCandidates.map((item) => {
      const bureauLabel = state.bureauContacts[item.bureau]?.displayName || cap(item.bureau);
      return `
        <tr data-id="${item.id}">
          <td class="cb-col"><input type="checkbox" class="pi-check" data-itemid="${item.id}" /></td>
          <td>${escapeHtml(FIELD_LABELS[item.field] || item.field)}</td>
          <td class="cell-value">${escapeHtml(item.value || '')}</td>
          <td class="bureau-col">${escapeHtml(bureauLabel)}</td>
          <td>${reasonSelectHtml(item.id, state.personalInfoReasons, defaultReason)}</td>
        </tr>
      `;
    }).join('');
    wireReasonSelects(piTbody);
  }

  function wireReasonSelects(scope) {
    scope.querySelectorAll('.reason-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const itemId = sel.dataset.itemid;
        const custom = scope.querySelector(`.reason-custom[data-itemid="${cssEscape(itemId)}"]`);
        if (!custom) return;
        if (sel.value === '__custom__') {
          custom.classList.remove('hidden');
          custom.focus();
        } else {
          custom.classList.add('hidden');
        }
      });
    });
  }

  generateBtn.addEventListener('click', async () => {
    const client = {
      fullName: document.getElementById('ci_fullName').value.trim(),
      address: document.getElementById('ci_address').value.trim(),
      cityStateZip: document.getElementById('ci_cityStateZip').value.trim(),
      dob: document.getElementById('ci_dob').value.trim(),
      ssnLast4: document.getElementById('ci_ssnLast4').value.trim(),
    };
    const letterDate = document.getElementById('ci_letterDate').value.trim();

    if (!client.fullName) {
      alert('Enter the client\'s full legal name before generating letters.');
      return;
    }

    const itemSelections = collectSelections(itemsTbody, '.item-check', state.disputables);
    const personalInfoSelections = collectSelections(piTbody, '.pi-check', state.personalInfoCandidates, true);

    if (itemSelections.length === 0 && personalInfoSelections.length === 0) {
      alert('Check at least one item or personal-info entry before generating.');
      return;
    }

    show(statusCard);
    document.getElementById('statusHeadline').textContent = 'Generating three letters…';
    document.getElementById('statusBody').textContent = 'Building the Affidavit of Truth for each bureau, merging the FCRA §605B statute, and bundling the breach screenshot. About 20 seconds.';

    try {
      const resp = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientSlug: state.clientSlug,
          client,
          itemSelections,
          personalInfoSelections,
          letterDate,
          capturedReportPath: state.capturedReportPath,
        }),
      });
      const json = await resp.json();
      if (!json.ok) {
        errorBody.textContent = json.error || 'Letter generation failed.';
        show(errorCard);
        return;
      }
      renderResult(json, client.fullName);
      show(resultCard);
    } catch (err) {
      errorBody.textContent = err?.message || String(err);
      show(errorCard);
    }
  });

  function collectSelections(tbody, checkSelector, source, isPersonalInfo = false) {
    const sourceById = new Map(source.map((s) => [s.id, s]));
    const out = [];
    tbody.querySelectorAll(checkSelector).forEach((cb) => {
      if (!cb.checked) return;
      const id = cb.dataset.itemid;
      const item = sourceById.get(id);
      if (!item) return;
      const row = cb.closest('tr');
      const sel = row.querySelector('.reason-select');
      const customInput = row.querySelector('.reason-custom');
      const reasonId = sel ? sel.value : '';
      const customReasonText =
        reasonId === '__custom__' && customInput ? customInput.value.trim() : undefined;
      if (isPersonalInfo) {
        out.push({
          id: item.id,
          bureau: item.bureau,
          fieldLabel: FIELD_LABELS[item.field] || item.field,
          value: item.value,
          reasonId,
          customReasonText,
        });
      } else {
        out.push({
          id: item.id,
          bureau: item.bureau,
          creditor: item.creditor,
          detail: item.detail,
          reasonId,
          customReasonText,
        });
      }
    });
    return out;
  }

  function renderResult(json, name) {
    resultLede.textContent = `Three Affidavit of Truth letters for ${name} have been written to ${json.outDir}. Each PDF contains the affidavit, the FCRA §605B statute, and the breach screenshot. Print, sign, and mail certified with return receipt.`;
    letterLinks.innerHTML = json.letters.map((l) => {
      const bureauName = state.bureauContacts[l.bureau]?.displayName || cap(l.bureau);
      return `
        <a class="letter-link" href="${l.pdfUrl}" target="_blank" download>
          <div class="letter-bureau">${escapeHtml(bureauName)}</div>
          <div class="letter-meta">Open PDF →</div>
        </a>
      `;
    }).join('');
  }

  backToFormBtn.addEventListener('click', () => show(formCard));
  newClientBtn.addEventListener('click', () => {
    pullForm.reset();
    last4Field.style.display = 'none';
    show(formCard);
  });
  errorReset.addEventListener('click', () => show(formCard));

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function cssEscape(s) {
    return String(s).replace(/(["\\])/g, '\\$1');
  }
})();
