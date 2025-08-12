// public/script.js
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

// Downscale oversized images to max width
async function downscaleImage(file, maxW = 1600, quality = 0.9) {
  if (!file.type.startsWith('image/')) return file;
  const img = document.createElement('img');
  const url = URL.createObjectURL(file);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const scale = Math.min(1, maxW / img.naturalWidth);
  if (scale >= 1) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const mime = file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise(r => canvas.toBlob(r, mime, quality));
  return new File([blob], file.name.replace(/\.(png|jpg|jpeg|webp)$/i, '') + (mime==='image/webp'?'.webp':'.jpg'), { type: mime });
}

drop?.addEventListener('click', () => fileInput.click());
drop?.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hover'); });
drop?.addEventListener('dragleave', () => drop.classList.remove('hover'));
drop?.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('hover');
  const f = e.dataTransfer.files?.[0];
  if (f) {
    selectedFile = await downscaleImage(f);
    showPreview(selectedFile);
  }
});

fileInput?.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (f) {
    selectedFile = await downscaleImage(f);
    showPreview(selectedFile);
  }
});

analyzeBtn?.addEventListener('click', async () => {
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
