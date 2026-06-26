/* ---------------------------------------------------------------------
 * Shared "raw data" file attachment widget -- used on both Browse Data's
 * Reagent Master tab and the Lot Comparison page, so the same attachment
 * is visible from either place since both key off instrument+category+item.
 *
 * Files upload directly from the browser to Supabase Storage (same
 * direct-to-storage pattern browse.html already used for final report
 * PDFs), then a small metadata record is saved via /api/browse?action=raw-data.
 * Direct-to-storage means there's no Vercel body-size limit on the file
 * itself -- only Supabase Storage's own limits apply.
 *
 * Any file type, any number of files per upload.
 *
 * Usage:
 *   <div id="rawdata-123">${RawData.render('rawdata-123', instrument, category, item)}</div>
 *   RawData.init('rawdata-123', instrument, category, item);  // after the HTML is in the DOM
 * ------------------------------------------------------------------- */
var RawData = (function () {
  var SUPABASE_URL = "https://usugysirjyyoqmlakkbc.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_uoEd0a25XYnr9rVMrusJjA_eliyxszy";

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  function render(domId, instrument, category, item) {
    return (
      '<div class="raw-data-panel no-print" data-instrument="' + escapeHtml(instrument) + '" data-category="' + escapeHtml(category) + '" data-item="' + escapeHtml(item) + '">' +
        '<button type="button" class="raw-data-toggle" data-rd-action="toggle" data-rd-target="' + domId + '">' +
          '<span class="raw-data-count" id="' + domId + '-count">Raw data</span>' +
        '</button>' +
        '<div class="raw-data-body" id="' + domId + '-body" style="display:none;">' +
          '<div class="raw-data-list" id="' + domId + '-list"><span class="raw-data-muted">Loading...</span></div>' +
          '<label class="raw-data-upload-btn">' +
            '+ Upload file(s)' +
            '<input type="file" multiple style="display:none;" data-rd-action="upload" data-rd-target="' + domId + '">' +
          '</label>' +
          '<span class="raw-data-status" id="' + domId + '-status"></span>' +
        '</div>' +
      '</div>'
    );
  }

  function init(domId, instrument, category, item) {
    bindOnce();
    refresh(domId, instrument, category, item);
  }

  var bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-rd-action="toggle"]');
      if (!el) return;
      var targetId = el.dataset.rdTarget;
      var body = document.getElementById(targetId + '-body');
      if (!body) return;
      var opening = body.style.display === 'none';
      body.style.display = opening ? 'block' : 'none';
    });
    document.addEventListener('change', function (e) {
      var el = e.target.closest('[data-rd-action="upload"]');
      if (!el || !el.files || el.files.length === 0) return;
      var targetId = el.dataset.rdTarget;
      var panel = el.closest('.raw-data-panel');
      var instrument = panel.dataset.instrument;
      var category = panel.dataset.category;
      var item = panel.dataset.item;
      if (!instrument || !category || !item) {
        alert('Fill in Instrument, Category, and Item/Analyte first so this file has something to attach to.');
        el.value = '';
        return;
      }
      uploadFiles(targetId, instrument, category, item, el.files);
      el.value = ''; // allow re-selecting the same file later
    });
  }

  function refresh(domId, instrument, category, item) {
    var listEl = document.getElementById(domId + '-list');
    var countEl = document.getElementById(domId + '-count');
    if (!listEl) return;
    if (!instrument || !category || !item) {
      if (countEl) countEl.textContent = 'Raw data';
      listEl.innerHTML = '<span class="raw-data-muted">Fill in Instrument, Category, and Item/Analyte above first.</span>';
      return;
    }
    var params = new URLSearchParams({ action: 'raw-data', instrument: instrument || '', category: category || '', item: item || '' });
    fetch('/api/browse?' + params.toString())
      .then(function (r) { return r.json(); })
      .then(function (files) {
        if (files.error) throw new Error(files.error);
        if (countEl) countEl.textContent = '\uD83D\uDCCE Raw data (' + files.length + ')';
        if (files.length === 0) {
          listEl.innerHTML = '<span class="raw-data-muted">No files uploaded yet.</span>';
          return;
        }
        listEl.innerHTML = files.map(function (f) {
          return '<div class="raw-data-file">' +
            '<a href="' + escapeHtml(f.file_url) + '" target="_blank" rel="noopener">' + escapeHtml(f.filename) + '</a>' +
            '<span class="raw-data-meta">' + fmtSize(f.file_size) + ' \u00b7 ' + fmtDate(f.uploaded_at) + '</span>' +
            '<button type="button" class="raw-data-delete" data-rd-delete="' + f.id + '" data-rd-refresh="' + domId + '" title="Delete">&times;</button>' +
          '</div>';
        }).join('');
        listEl.querySelectorAll('[data-rd-delete]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (!confirm('Delete this file? This cannot be undone.')) return;
            deleteFile(btn.dataset.rdDelete, domId, instrument, category, item);
          });
        });
      })
      .catch(function (err) {
        listEl.innerHTML = '<span class="raw-data-muted">Error loading files: ' + escapeHtml(err.message) + '</span>';
      });
  }

  function uploadFiles(domId, instrument, category, item, fileList) {
    var statusEl = document.getElementById(domId + '-status');
    var files = Array.prototype.slice.call(fileList);
    var total = files.length;
    var done = 0;
    if (statusEl) statusEl.textContent = 'Uploading 1 of ' + total + '...';

    function uploadOne(file) {
      var safeName = file.name.replace(/[^a-zA-Z0-9_.\-]+/g, '_');
      var storagePath = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + safeName;
      return fetch(SUPABASE_URL + '/storage/v1/object/raw-data/' + storagePath, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      }).then(function (uploadRes) {
        if (!uploadRes.ok) return uploadRes.text().then(function (t) { throw new Error('Upload failed: ' + t); });
        var fileUrl = SUPABASE_URL + '/storage/v1/object/public/raw-data/' + storagePath;
        return fetch('/api/browse?action=raw-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instrument: instrument, category: category, item: item,
            filename: file.name, fileUrl: fileUrl, fileSize: file.size, contentType: file.type,
          }),
        }).then(function (r) { return r.json(); });
      });
    }

    files.reduce(function (chain, file) {
      return chain.then(function () {
        return uploadOne(file).then(function (res) {
          done++;
          if (statusEl) statusEl.textContent = done < total ? ('Uploading ' + (done + 1) + ' of ' + total + '...') : '';
          if (res && res.error) throw new Error(res.error);
        });
      });
    }, Promise.resolve())
      .then(function () { refresh(domId, instrument, category, item); })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = 'Error: ' + err.message;
      });
  }

  function deleteFile(id, domId, instrument, category, item) {
    fetch('/api/browse?action=raw-data&id=' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) throw new Error(res.error);
        refresh(domId, instrument, category, item);
      })
      .catch(function (err) {
        alert('Delete failed: ' + err.message);
      });
  }

  return { render: render, init: init, refresh: refresh };
})();

(function injectStyles() {
  var css = '.raw-data-panel{margin-top:8px;}' +
    '.raw-data-toggle{background:none;border:1px solid #dbe2e8;border-radius:6px;padding:5px 10px;font-size:11.5px;font-weight:600;color:#5f7385;cursor:pointer;}' +
    '.raw-data-toggle:hover{background:#eef2f6;}' +
    '.raw-data-body{margin-top:8px;padding:10px 12px;border:1px solid #dbe2e8;border-radius:8px;background:#fafbfc;}' +
    '.raw-data-list{margin-bottom:8px;}' +
    '.raw-data-file{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:4px 0;border-bottom:1px solid #eef2f6;}' +
    '.raw-data-file:last-child{border-bottom:none;}' +
    '.raw-data-file a{color:#2f6fa3;text-decoration:none;font-weight:600;}' +
    '.raw-data-file a:hover{text-decoration:underline;}' +
    '.raw-data-meta{color:#5f7385;font-size:11px;margin-left:auto;}' +
    '.raw-data-delete{background:none;border:none;color:#b3261e;font-size:16px;cursor:pointer;line-height:1;padding:0 2px;}' +
    '.raw-data-muted{color:#5f7385;font-size:12px;}' +
    '.raw-data-upload-btn{display:inline-block;padding:6px 12px;border:1px solid #0f2a47;border-radius:6px;font-size:12px;font-weight:600;color:#0f2a47;cursor:pointer;background:#fff;}' +
    '.raw-data-upload-btn:hover{background:#eef2f6;}' +
    '.raw-data-status{margin-left:10px;font-size:11.5px;color:#5f7385;}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
})();
