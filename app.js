// WASM init. Hardened builds expose compact export names; alias them here so no
// extra wrapper module is needed in the deployed artifact.
import init, {
  a as load_ctx,
  b as proc_ctx,
  c as hash_buf,
  d as probe_ctx,
  e as verify_ctx,
} from './pkg/gimi_snowflake_core.js?v=e5a5771e4f06ff158ba58e4a5861b7957e60a7f3';

const dot = document.getElementById('wasm-dot');
const status = document.getElementById('wasm-status');

// Base/original DLL (unpatched) and optional mutated DLL for verify mode.
let fileBytes = null;
let fileName = '';
let mutBytes = null;
let mutName = '';
let lastResult = null;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

try {
  await init({ module_or_path: new URL('./pkg/gimi_snowflake_core_bg.wasm?v=e5a5771e4f06ff158ba58e4a5861b7957e60a7f3', import.meta.url) });
  dot.classList.add('ready');
  status.textContent = 'WASM ready';
} catch (e) {
  status.textContent = 'WASM failed: ' + e;
  dot.classList.add('failed');
}

// DOM refs.
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileMeta = document.getElementById('file-meta');
const analyzePanel = document.getElementById('analyze-panel');
const resultPanel = document.getElementById('result-panel');
const btnPatch = document.getElementById('btn-patch');
const btnDownload = document.getElementById('download-btn');
const prog = document.getElementById('prog');
const logEl = document.getElementById('log');
const dropHint = document.getElementById('drop-hint');

// Logging.
function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// Patched detection runs in Rust (core.rs) and is exposed via probe_ctx.

// File load.
function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    log(`[!] File too large: ${fmtBytes(file.size)}. Maximum supported size is ${fmtBytes(MAX_UPLOAD_BYTES)}.`, 'err');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const bytes = new Uint8Array(e.target.result);
    const hadBase = fileBytes !== null;

    // ── If a patched DLL is dropped first, store it and wait for original.
    // This avoids calling load_ctx (strict heuristics) on already-patched inputs.
    if (fileBytes === null && mutBytes === null) {
      const r = probe_ctx(bytes);
      const peOk = r.pe_ok;
      const gimiLike = r.gimi_like;
      const patched = r.patched;
      r.free();

      if (peOk && gimiLike && patched) {
        mutBytes = bytes;
        mutName = file.name;

        document.getElementById('meta-name').textContent = file.name;
        document.getElementById('meta-size').textContent = fmtBytes(mutBytes.length);
        try { document.getElementById('meta-sha').textContent = hash_buf(mutBytes); } catch (_) {
          document.getElementById('meta-sha').textContent = '—';
        }
        fileMeta.classList.remove('hidden');
        dropZone.classList.add('has-file');
        dropZone.querySelector('.drop-text').textContent = `${file.name} (patched)`;

        analyzePanel.classList.add('hidden');
        btnPatch.disabled = true;
        lastResult = null;
        btnDownload.classList.add('is-hidden');
        resultPanel.classList.add('hidden');
        dropHint.textContent = 'Detected patched DLL. Drop the original DLL next.';
        dropHint.classList.remove('hidden');
        log('[*] Detected patched DLL. Drop the original DLL next to enter Verify mode.', 'info');
        return;
      } else if (peOk && !gimiLike) {
        log('[!] Unsupported DLL (not a GIMI proxy DLL).', 'err');
      }
    }

    // ── If we already have a patched DLL, try to verify using this as the base.
    if (fileBytes === null && mutBytes !== null && bytes.length === mutBytes.length) {
      try {
        const r = verify_ctx(bytes, mutBytes);
        const changed = r.sleds_changed;
        if (changed > 0) {
          // Treat this file as the original/base DLL.
          fileBytes = bytes;
          fileName = file.name;
          renderVerifyResult(r, mutName);
          r.free();
          log(`[*] Verify mode: original=${file.name} mutated=${mutName}`, 'info');
          return;
        }
        r.free();
      } catch (_) {
        // fall through
      }
    }

    // ── 自動偵測：同尺寸時先做 sled diff；真的改過才切到 Verify 模式
    if (fileBytes !== null && bytes.length === fileBytes.length) {
      const newHash = hash_buf(bytes);
      const origHash = document.getElementById('meta-sha').textContent;
      if (origHash !== '—' && newHash !== origHash) {
        try {
          const r = verify_ctx(fileBytes, bytes);
          const changed = r.sleds_changed;
          if (changed > 0) {
            renderVerifyResult(r, file.name);
            r.free();
            log(`[*] Auto-switched to Verify mode for ${file.name}`, 'info');
            return;
          }
          r.free();
        } catch (_) {
          // If verification fails, fall through and treat it as a new base DLL.
        }
      }
    }

    // ── 載入為原始 DLL（strict）
    try {
      const info = load_ctx(bytes);

      fileBytes = bytes;
      fileName = file.name;
      mutBytes = null;
      mutName = '';

      document.getElementById('meta-name').textContent = file.name;
      document.getElementById('meta-size').textContent = fmtBytes(fileBytes.length);
      fileMeta.classList.remove('hidden');
      dropZone.classList.add('has-file');
      dropZone.querySelector('.drop-text').textContent = file.name;
      dropHint.textContent = '';
      dropHint.classList.add('hidden');

      document.getElementById('meta-sha').textContent = info.checksum;
      document.getElementById('s-total').textContent = info.sled_count;
      document.getElementById('s-int3').textContent = info.int3_count;
      document.getElementById('s-nop').textContent = info.nop_count;
      analyzePanel.classList.remove('hidden');
      btnPatch.disabled = false;
      lastResult = null;
      btnDownload.classList.add('is-hidden');
      resultPanel.classList.add('hidden');
      log(`[*] Loaded ${file.name} — ${info.sled_count} padding sleds (INT3:${info.int3_count} NOP:${info.nop_count})`, 'info');
    } catch (err) {
      // If strict loader blocks (often due to patched DLL), try a lightweight probe.
      const r = probe_ctx(bytes);
      const peOk = r.pe_ok;
      const gimiLike = r.gimi_like;
      const patched = r.patched;
      r.free();

      if (peOk && gimiLike && patched) {
        // Store as mutated candidate so user can drop base next.
        mutBytes = bytes;
        mutName = file.name;
        if (!hadBase) {
          fileBytes = null;
          fileName = '';
        }

        document.getElementById('meta-name').textContent = file.name;
        document.getElementById('meta-size').textContent = fmtBytes(mutBytes.length);
        try { document.getElementById('meta-sha').textContent = hash_buf(mutBytes); } catch (_) {
          document.getElementById('meta-sha').textContent = '—';
        }
        fileMeta.classList.remove('hidden');
        dropZone.classList.add('has-file');
        dropZone.querySelector('.drop-text').textContent = `${file.name} (patched)`;
        analyzePanel.classList.add('hidden');
        btnPatch.disabled = true;
        lastResult = null;
        btnDownload.classList.add('is-hidden');
        resultPanel.classList.add('hidden');

        dropHint.textContent = 'Detected patched DLL. Drop the original DLL next.';
        dropHint.classList.remove('hidden');

        log('[*] Detected patched DLL. Drop the original DLL to enter Verify mode.', 'info');
      } else if (peOk && !gimiLike) {
        log('[!] Unsupported DLL (not a GIMI proxy DLL).', 'err');
      } else {
        log(`[!] ${err}`, 'err');
      }
    }
  };
  reader.readAsArrayBuffer(file);
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => loadFile(e.target.files[0]));
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  loadFile(e.dataTransfer.files[0]);
});

// ── Patch ────────────────────────────────────────────────────────────────
btnPatch.addEventListener('click', async () => {
  if (!fileBytes) return;
  const count = parseInt(document.getElementById('opt-count').value) || 128;
  const level = parseInt(document.getElementById('opt-level').value) || 0;
  const seedVal = document.getElementById('opt-seed').value.trim();
  const seed = seedVal ? seedVal : "0";  // Full string to avoid precision loss

  btnPatch.disabled = true;
  resultPanel.classList.add('hidden');
  logEl.innerHTML = '';
  prog.classList.remove('is-complete');
  prog.classList.add('is-started');

  log(`[*] Patching ${fileName} — count=${count} level=${level} seed=${seed === "0" ? 'random' : seed}`, 'info');

  let blobResult = null;
  let lastMut = 0, lastSeed = '', hashBefore = '', hashAfter = '';

  try {
    const result = proc_ctx(fileBytes, count, seed, level);
    // Extract all fields BEFORE free() — after free() the Rust object is invalid
    const patched = result.payload();
    const mutations = result.mutations;
    const seedUsed = result.seed;
    const hBefore = result.hashBefore;
    const hAfter = result.hashAfter;
    result.free();
    lastMut = mutations;
    lastSeed = seedUsed;
    hashBefore = hBefore;
    hashAfter = hAfter;
    blobResult = { name: fileName, bytes: patched };
    log(`[+] patched  mutations=${mutations}  seed=${seedUsed}`, 'ok');
    prog.classList.remove('is-started');
    prog.classList.add('is-complete');

    // Track patch_success event via GoatCounter
    if (window.goatcounter && typeof window.goatcounter.count === 'function') {
      window.goatcounter.count({
        path: 'patch_success',
        title: 'DLL patch success',
        event: true,
        no_session: true
      });
    }
  } catch (err) {
    log(`[!] patch failed: ${err}`, 'err');
    btnPatch.disabled = false;
    prog.classList.remove('is-started', 'is-complete');
    return;
  }

  // Result panel
  document.getElementById('result-title').textContent = '✅ Result';
  document.getElementById('gen-result-inner').classList.remove('hidden');
  document.getElementById('ver-result-inner').classList.add('hidden');
  document.getElementById('r-mutations').textContent = lastMut;
  document.getElementById('r-seed').textContent = lastSeed;
  document.getElementById('h-before').textContent = hashBefore;
  document.getElementById('h-after').textContent = hashAfter;
  resultPanel.classList.remove('hidden');

  lastResult = blobResult;
  btnPatch.disabled = false;
  btnDownload.classList.remove('is-hidden');
  log('[+] Done — output generated. Auto-downloading...', 'ok');

  // Auto trigger download
  btnDownload.click();
});

// ── Verify ──────────────────────────────────────────────────────────────
function renderVerifyResult(r, name) {
  // ── Status badges ────────────────────────────────────────────────────
  const checksEl = document.getElementById('verify-checks');
  checksEl.innerHTML = '';
  const mkBadge = (cls, text) => {
    const el = document.createElement('span');
    el.className = `check-badge ${cls}`;
    el.textContent = text;
    return el;
  };
  checksEl.appendChild(mkBadge(r.pe_ok ? 'ok' : 'fail',
    r.pe_ok ? '✓ PE Valid' : '✗ PE Invalid'));
  checksEl.appendChild(mkBadge(r.checksum_ok ? 'ok' : 'fail',
    r.checksum_ok ? '✓ Checksum OK' : '✗ Checksum Fail'));
  checksEl.appendChild(mkBadge('info', `Sections: ${r.section_count}`));
  checksEl.appendChild(mkBadge(r.has_cfg ? 'warn' : 'ok',
    r.has_cfg ? '⚠ CFG ON' : 'CFG: OFF'));

  document.getElementById('result-title').textContent = '🔍 Verify';
  document.getElementById('gen-result-inner').classList.add('hidden');
  document.getElementById('ver-result-inner').classList.remove('hidden');
  document.getElementById('ver-filename').textContent = `Comparing original ${fileName} against ${name}`;

  // ── File / .text info ────────────────────────────────────────────────
  document.getElementById('v-filesize').textContent = fmtBytes(r.file_size);
  document.getElementById('v-textoff').textContent =
    '0x' + r.text_offset.toString(16).toUpperCase().padStart(8, '0');
  document.getElementById('v-textsz').textContent = fmtBytes(r.text_size);

  // ── Sled diff ────────────────────────────────────────────────────────
  const pct = r.sleds_total > 0 ? (r.sleds_changed / r.sleds_total * 100) : 0;
  document.getElementById('v-sled-bar').style.setProperty('--sled-progress', `${Math.min(100, pct)}%`);
  document.getElementById('v-sled-ratio').textContent =
    `${r.sleds_changed.toLocaleString()} / ${r.sleds_total.toLocaleString()}`;

  const changed = JSON.parse(r.changedSleds);
  const tagsEl = document.getElementById('v-sled-tags');
  tagsEl.innerHTML = '';
  const MAX_TAGS = 100;
  for (const s of changed.slice(0, MAX_TAGS)) {
    const tag = document.createElement('span');
    tag.className = 'sled-tag';
    tag.textContent =
      `#${s.i}  0x${s.off.toString(16).toUpperCase().padStart(8, '0')}  ${s.len}B`;
    tagsEl.appendChild(tag);
  }
  const moreEl = document.getElementById('v-sled-more');
  moreEl.textContent = changed.length > MAX_TAGS
    ? `... and ${changed.length - MAX_TAGS} more`
    : '';

  resultPanel.classList.remove('hidden');
}

// Download.
btnDownload.addEventListener('click', async () => {
  if (!lastResult) return;
  saveBlob(lastResult.bytes, lastResult.name);
});

// Helpers.
function saveBlob(buffer, name) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([buffer]));
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}
