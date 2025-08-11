const fileInput = document.getElementById('file');
const drop = document.getElementById('drop');
const analyzeBtn = document.getElementById('analyze');
const preview = document.getElementById('preview');
const results = document.getElementById('results');
const stateEl = document.getElementById('state');
const adviceEl = document.getElementById('advice');

let selectedFile = null;

function showPreview(file) {
  const url = URL.createObjectURL(file);
  preview.innerHTML = `<img src="${url}" alt="preview" />`;
}

drop.addEventListener('click', () => fileInput.click());

drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('hover'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('hover');
  const f = e.dataTransfer.files?.[0];
  if (f) { selectedFile = f; showPreview(f); }
});

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) { selectedFile = f; showPreview(f); }
});

analyzeBtn.addEventListener('click', async () => {
  if (!selectedFile) {
    alert('Please choose an image first.');
    return;
  }
  const fd = new FormData();
  fd.append('image', selectedFile);

  adviceEl.innerHTML = '';
  stateEl.textContent = 'Analyzing...';
  results.classList.remove('hidden');

  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok) {
      stateEl.textContent = JSON.stringify(data, null, 2);
      adviceEl.innerHTML = '<p class="error">Extraction failed. See details above.</p>';
      return;
    }

    stateEl.textContent = JSON.stringify(data.state, null, 2);

    const r = data.recommendation;
    if (r) {
      const rows = (r.options || []).map(o => {
        const size = o.size ? ` · size: ${o.size}` : '';
        return `<li><strong>${o.action}</strong> · <em>${o.frequency}%</em>${size}</li>`;
      }).join('');

      adviceEl.innerHTML = `
        <div class="card">
          <h3>Recommended Next Action (${r.street})</h3>
          <ul>${rows}</ul>
          <p class="notes">${r.notes || ''}</p>
        </div>
      `;
    } else {
      adviceEl.innerHTML = '<p class="error">No recommendation returned.</p>';
    }
  } catch (e) {
    stateEl.textContent = '';
    adviceEl.innerHTML = `<p class="error">${e?.message || 'Network error'}</p>`;
  }
});
