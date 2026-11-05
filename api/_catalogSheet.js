/**
 * Server-side catalog sheet generation (not a serverless function itself --
 * the leading underscore keeps Vercel from counting it toward the Hobby cap).
 *
 * Two kinds of automatic sheet are saved to catalog_sheet_history:
 *
 *   COMPLETE -- saved the moment the last item in a count cycle is marked
 *               reviewed. Saved at most ONCE per cycle, so later edits
 *               after everything is reviewed don't create duplicates.
 *
 *   WEEKLY   -- saved by the Sunday-night GitHub Action right before the
 *               weekly review reset. Records whatever state the count is
 *               in, listing every item left unreviewed at the top. Skipped
 *               only when the cycle was finished AND its COMPLETE sheet
 *               already exists (that sheet is the record for the week).
 *
 * Both are built from a fresh database read, never from a browser's copy
 * of the list, so items counted on other devices show correctly.
 */
const supabase = require('./_supabase');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const autoTable = autoTableModule.default || autoTableModule.autoTable || autoTableModule;

// filter_summary prefixes double as the "kind" marker for dedup lookups,
// so the history table needs no schema change.
const COMPLETE_PREFIX = 'All items (auto-saved — all items reviewed)';
const WEEKLY_PREFIX = 'Weekly snapshot';

const TZ = 'America/Chicago';

function fmtDate(v) {
  if (!v) return '--';
  return new Date(v).toLocaleString('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function loadRows() {
  const { data, error } = await supabase
    .from('inventory')
    .select('catalog_id, last_reviewed_at, reviewed_by, catalog(analyzer, category, item, manufacturer_ref, storage_location, storage_temperature)')
    .order('catalog_id');
  if (error) throw error;
  return data.map((r) => ({
    catalog_id: r.catalog_id,
    last_reviewed_at: r.last_reviewed_at,
    reviewed_by: r.reviewed_by,
    analyzer: (r.catalog && r.catalog.analyzer) || 'Unassigned',
    category: (r.catalog && r.catalog.category) || '',
    item: (r.catalog && r.catalog.item) || '',
    manufacturer_ref: (r.catalog && r.catalog.manufacturer_ref) || '--',
    storage_location: (r.catalog && r.catalog.storage_location) || '--',
    storage_temperature: (r.catalog && r.catalog.storage_temperature) || '--',
  }));
}

function groupByAnalyzer(rows) {
  const groups = {};
  rows.forEach((r) => { (groups[r.analyzer] = groups[r.analyzer] || []).push(r); });
  const names = Object.keys(groups).sort();
  names.forEach((n) => groups[n].sort((a, b) => a.item.localeCompare(b.item, undefined, { numeric: true })));
  return { groups, names };
}

function reviewedText(r) {
  if (!r.last_reviewed_at) return 'NOT REVIEWED';
  return 'Yes - ' + fmtDate(r.last_reviewed_at) + (r.reviewed_by ? ' - ' + r.reviewed_by : '');
}

function buildPdf(rows, { title, subtitle }) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const PAGE_W = 792, MARGIN = 32, HEADER_H = 56;
  const unreviewed = rows.filter((r) => !r.last_reviewed_at);
  const generated = fmtDate(new Date());

  function drawChrome(data) {
    doc.setFillColor(17, 43, 71);
    doc.rect(0, 0, PAGE_W, HEADER_H, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text('ALTRU DIAGNOSTICS — ' + title, MARGIN, 24);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.setTextColor(207, 224, 240);
    doc.text(subtitle, MARGIN, 40);
    doc.text(rows.length + ' items · Auto-generated ' + generated + ' (Central)', PAGE_W - MARGIN, 24, { align: 'right' });
    doc.text('Page ' + data.pageNumber, PAGE_W - MARGIN, 40, { align: 'right' });
  }

  const baseStyles = { font: 'helvetica', fontSize: 8.5, cellPadding: 4.5, valign: 'middle', lineColor: [213, 221, 229], lineWidth: 0.5 };
  const margin = { left: MARGIN, right: MARGIN, top: HEADER_H + 14, bottom: 24 };
  let startY = HEADER_H + 14;

  // Up-front list of what was left unreviewed, so it can't be missed.
  if (unreviewed.length > 0) {
    const { groups, names } = groupByAnalyzer(unreviewed);
    const body = [];
    names.forEach((n) => {
      groups[n].forEach((r) => body.push([n, r.item, r.manufacturer_ref, r.storage_location]));
    });
    autoTable(doc, {
      startY, margin, rowPageBreak: 'avoid',
      head: [[{ content: unreviewed.length + ' of ' + rows.length + ' item' + (rows.length === 1 ? '' : 's') + ' NOT reviewed this cycle', colSpan: 4 }],
        ['Instrument', 'Item', 'MFR Ref', 'Location']],
      body,
      styles: baseStyles,
      headStyles: { fillColor: [179, 38, 30], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      alternateRowStyles: { fillColor: [251, 236, 234] },
      columnStyles: { 0: { cellWidth: 150 }, 1: { cellWidth: 260 }, 2: { cellWidth: 110 }, 3: { cellWidth: 'auto' } },
      didDrawPage: drawChrome,
    });
    startY = doc.lastAutoTable.finalY + 22;
  }

  const { groups, names } = groupByAnalyzer(rows);
  const body = [];
  names.forEach((n) => {
    const list = groups[n];
    const rc = list.filter((r) => !!r.last_reviewed_at).length;
    body.push([{
      content: n + '  (' + list.length + ' item' + (list.length === 1 ? '' : 's') + ', ' + rc + '/' + list.length + ' reviewed)',
      colSpan: 6,
      styles: { fillColor: [28, 63, 99], textColor: 255, fontStyle: 'bold', fontSize: 9.5, halign: 'left' },
    }]);
    list.forEach((r) => body.push([r.item, r.category, r.manufacturer_ref, r.storage_location, r.storage_temperature, reviewedText(r)]));
  });

  autoTable(doc, {
    startY, margin, rowPageBreak: 'avoid',
    head: [['Item', 'Item Type', 'MFR Ref', 'Location', 'Temperature', 'Reviewed']],
    body,
    styles: baseStyles,
    headStyles: { fillColor: [17, 43, 71], textColor: 255, fontStyle: 'bold', fontSize: 9 },
    alternateRowStyles: { fillColor: [238, 242, 246] },
    columnStyles: { 0: { cellWidth: 195 }, 1: { cellWidth: 85 }, 2: { cellWidth: 100 }, 3: { cellWidth: 155 }, 4: { cellWidth: 80 }, 5: { cellWidth: 'auto' } },
    didParseCell(data) {
      if (data.section === 'body' && data.column.index === 5) {
        const raw = String(data.cell.raw || '');
        if (raw === 'NOT REVIEWED') { data.cell.styles.textColor = [179, 38, 30]; data.cell.styles.fontStyle = 'bold'; }
        else if (raw.indexOf('Yes') === 0) { data.cell.styles.textColor = [27, 122, 61]; }
      }
    },
    didDrawPage: drawChrome,
  });

  return Buffer.from(doc.output('arraybuffer'));
}

async function saveSheet(pdfBuffer, { generatedBy, itemCount, filterSummary }) {
  const path = 'catalog-sheet_' + Date.now() + '.pdf';
  const { error: uploadErr } = await supabase.storage
    .from('reports')
    .upload(path, pdfBuffer, { contentType: 'application/pdf' });
  if (uploadErr) throw uploadErr;
  const { data: urlData } = supabase.storage.from('reports').getPublicUrl(path);
  const { data, error } = await supabase
    .from('catalog_sheet_history')
    .insert({ generated_by: generatedBy || null, item_count: itemCount, filter_summary: filterSummary, pdf_url: urlData.publicUrl })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Start of the current count cycle = the earliest review stamp still on
// the board (reset clears them all, so this is when counting began).
function cycleStart(rows) {
  const stamps = rows.map((r) => r.last_reviewed_at).filter(Boolean).sort();
  return stamps.length ? stamps[0] : null;
}

async function completeSheetExistsSince(since) {
  const { data, error } = await supabase
    .from('catalog_sheet_history')
    .select('id')
    .like('filter_summary', COMPLETE_PREFIX + '%')
    .gte('generated_at', since)
    .limit(1);
  if (error) throw error;
  return data.length > 0;
}

async function weeklySheetExistsSince(since) {
  const { data, error } = await supabase
    .from('catalog_sheet_history')
    .select('id')
    .like('filter_summary', WEEKLY_PREFIX + '%')
    .gte('generated_at', since)
    .limit(1);
  if (error) throw error;
  return data.length > 0;
}

/**
 * kind: 'complete' (called from the Inventory page when the last item is
 * reviewed) or 'weekly' (called by the scheduled job before the reset).
 * Returns { saved: true, sheet } or { saved: false, reason }.
 */
async function autoCatalogSheet(kind, generatedBy) {
  const rows = await loadRows();
  if (rows.length === 0) return { saved: false, reason: 'No inventory items.' };

  const unreviewed = rows.filter((r) => !r.last_reviewed_at);
  const start = cycleStart(rows);
  const cycleComplete = unreviewed.length === 0;
  const alreadyRecorded = cycleComplete && start ? await completeSheetExistsSince(start) : false;

  if (kind === 'complete') {
    if (!cycleComplete) return { saved: false, reason: unreviewed.length + ' item(s) still unreviewed.' };
    if (alreadyRecorded) return { saved: false, reason: 'This count was already saved.' };
    const pdf = buildPdf(rows, { title: 'Catalog Sheet (all items reviewed)', subtitle: 'Count completed — every item reviewed' });
    const sheet = await saveSheet(pdf, { generatedBy, itemCount: rows.length, filterSummary: COMPLETE_PREFIX });
    return { saved: true, sheet };
  }

  if (kind === 'weekly') {
    if (alreadyRecorded) return { saved: false, reason: 'Count was completed and already saved this cycle.' };
    // Guard against the job being run twice in the same week.
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
    if (await weeklySheetExistsSince(sixDaysAgo)) return { saved: false, reason: 'A weekly snapshot was already saved in the last 6 days.' };
    const reviewedCount = rows.length - unreviewed.length;
    const summary = WEEKLY_PREFIX + ' — ' + reviewedCount + ' of ' + rows.length + ' reviewed, ' + unreviewed.length + ' left unreviewed';
    const pdf = buildPdf(rows, {
      title: 'Catalog Sheet (weekly snapshot)',
      subtitle: cycleComplete
        ? 'Saved at end of week — every item reviewed'
        : 'Saved at end of week — ' + unreviewed.length + ' item(s) NOT reviewed (listed first)',
    });
    const sheet = await saveSheet(pdf, { generatedBy: 'Automatic (weekly)', itemCount: rows.length, filterSummary: summary });
    return { saved: true, sheet };
  }

  throw new Error('Unknown sheet kind: ' + kind);
}

module.exports = { autoCatalogSheet, buildPdf };
