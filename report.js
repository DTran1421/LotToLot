/**
 * Shared report-rendering module.
 *
 * Used by compare.html to show the on-screen preview at submission time, and
 * by browse.html to regenerate the FINAL report (with reviewer name + date
 * baked in) at approval time. Keeping this in one file means the preview and
 * the final signed PDF are always built from the identical layout logic.
 *
 * Card shape expected: {
 *   analyteName, unit, oldLot, newLot, category,
 *   teaMode, teaPct, teaFixed, teaFixedUnit, teaSource,
 *   rows: [{sampleId, oldVal, newVal}],
 *   calc: {n, meanOld, meanNew, meanBiasPct, sdDiff, maxAbsPct, flaggedCount, allowedAtMean, pass}
 * }
 * Job shape expected: { instrument, date, reason, performedBy, comments }
 * Review info (optional): { verifiedBy, dateVerified }
 */

function reportAllowableDiff(c, tv) {
  if (c.teaMode === 'fixed') return c.teaFixed;
  if (c.teaMode === 'pct') return c.teaPct === null ? null : Math.abs(tv * c.teaPct / 100);
  if (c.teaMode === 'greater') {
    const a = c.teaFixed || 0;
    const b = c.teaPct === null ? 0 : Math.abs(tv * c.teaPct / 100);
    return Math.max(a, b);
  }
  return null;
}

function reportTeaDescription(c) {
  if (c.teaMode === 'fixed') return '\u00b1 ' + c.teaFixed + ' ' + c.teaFixedUnit;
  if (c.teaMode === 'pct') return '\u00b1 ' + c.teaPct + '%';
  if (c.teaMode === 'greater') return '\u00b1 ' + c.teaFixed + ' ' + c.teaFixedUnit + ' or \u00b1 ' + c.teaPct + '% (whichever greater)';
  return '--';
}

function reportAnalyteSectionHtml(c) {
  if (!c.calc) {
    return '<div class="report-section"><h3>' + (c.analyteName || '(unnamed analyte)') + '</h3><p class="small">No data entered for this analyte -- omitted from the verdict.</p></div>';
  }
  const calc = c.calc;
  const rowsHtml = (c.rows || []).map(function (r) {
    const oldV = parseFloat(r.oldVal), newV = parseFloat(r.newVal);
    if (isNaN(oldV) || isNaN(newV)) return '';
    const diff = newV - oldV, pct = oldV !== 0 ? (diff / oldV * 100) : 0;
    const allowed = reportAllowableDiff(c, oldV);
    const flag = allowed !== null && Math.abs(diff) > allowed;
    return '<tr style="' + (flag ? 'background:#fcebea;' : '') + '"><td>' + r.sampleId + '</td><td>' + oldV + '</td><td>' + newV + '</td><td>' + diff.toFixed(2) + '</td><td>' + pct.toFixed(1) + '%</td></tr>';
  }).join('');
  return '<div class="report-section">' +
    '<h3>' + (c.analyteName || '(unnamed analyte)') + ' <span class="pill ' + (calc.pass ? 'pass' : 'fail') + '">' + (calc.pass ? 'PASS' : 'FAIL') + '</span></h3>' +
    '<table class="meta-table">' +
    '<tr><td class="k">Old lot / New lot</td><td>' + (c.oldLot || '--') + ' &rarr; ' + (c.newLot || '--') + '</td></tr>' +
    '<tr><td class="k">CLIA TEa applied</td><td>' + reportTeaDescription(c) + ' &nbsp; <span class="small">(' + c.teaSource + ')</span></td></tr>' +
    '<tr><td class="k">n / mean old / mean new</td><td>' + calc.n + ' &nbsp; / &nbsp; ' + calc.meanOld.toFixed(2) + ' ' + c.unit + ' &nbsp; / &nbsp; ' + calc.meanNew.toFixed(2) + ' ' + c.unit + '</td></tr>' +
    '<tr><td class="k">Mean bias</td><td>' + (calc.meanBiasPct >= 0 ? '+' : '') + calc.meanBiasPct.toFixed(1) + '% (SD of differences ' + calc.sdDiff.toFixed(2) + ' ' + c.unit + ')</td></tr>' +
    '<tr><td class="k">Largest single-sample % diff</td><td>' + calc.maxAbsPct.toFixed(1) + '% &nbsp; (' + calc.flaggedCount + ' of ' + calc.n + ' sample(s) exceeded TEa individually)</td></tr>' +
    '</table>' +
    '<table><thead><tr><th>Sample ID</th><th>Old lot</th><th>New lot</th><th>Diff</th><th>% diff</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
    '</div>';
}

/**
 * Builds the full report HTML (the inner content only -- caller wraps it in
 * page chrome/buttons as needed). reviewInfo is null for the pre-approval
 * preview, or {verifiedBy, dateVerified} for the final, signed PDF.
 */
function buildReportContentHtml(job, cards, reviewInfo) {
  const overallPass = cards.length > 0 && cards.every(function (c) { return c.calc && c.calc.pass; });
  const anyMissing = cards.some(function (c) { return !c.calc; });
  const sections = cards.map(reportAnalyteSectionHtml).join('');

  const reviewedRow = reviewInfo
    ? '<tr><td class="k">Reviewed by</td><td>' + (reviewInfo.verifiedBy || '--') + '</td></tr>' +
      '<tr><td class="k">Date reviewed</td><td>' + (reviewInfo.dateVerified ? new Date(reviewInfo.dateVerified).toLocaleString() : '--') + '</td></tr>'
    : '';

  const sigGrid = reviewInfo
    ? '<div class="sig-grid"><div><div class="sig-line">Tested by / date</div><div class="small" style="margin-top:2px;">' + (job.performedBy || '--') + '</div></div>' +
      '<div><div class="sig-line">Reviewed by / date</div><div class="small" style="margin-top:2px;">' + (reviewInfo.verifiedBy || '--') + ' / ' + (reviewInfo.dateVerified ? new Date(reviewInfo.dateVerified).toLocaleDateString() : '--') + '</div></div></div>'
    : '<div class="sig-grid" style="grid-template-columns:1fr;max-width:340px;"><div><div class="sig-line">Tested by / date</div></div></div>' +
      '<p class="small" style="margin-top:10px;">This is a preview. Reviewer sign-off happens after this report is submitted -- the final, signed PDF is generated at approval time.</p>';

  return '<div class="masthead"><h1>Lot-to-Lot Comparison Report' + (reviewInfo ? ' (Final - Reviewed)' : ' (Preview - Pending Review)') + '</h1>' +
    '<p style="color:#c9d8e6;">' + (job.instrument || 'Instrument not specified') + ' &middot; ' + (job.date || 'date not specified') + '</p></div>' +
    '<div class="card"><table class="meta-table">' +
    '<tr><td class="k">Instrument</td><td>' + (job.instrument || '--') + '</td></tr>' +
    '<tr><td class="k">Date performed</td><td>' + (job.date || '--') + '</td></tr>' +
    '<tr><td class="k">Reason for lot change</td><td>' + (job.reason || '--') + '</td></tr>' +
    '<tr><td class="k">Tested by</td><td>' + (job.performedBy || '--') + '</td></tr>' +
    reviewedRow +
    '<tr><td class="k">Comments</td><td>' + (job.comments || '--') + '</td></tr>' +
    '</table>' +
    '<div class="verdict-banner ' + (overallPass ? 'pass' : 'fail') + '" style="margin-top:6px;">' +
    'Overall verdict: ' + (overallPass ? 'ACCEPTABLE -- new lot may be released into service' : 'NOT ACCEPTABLE -- one or more analytes failed CLIA acceptance criteria') +
    (anyMissing ? ' (one or more analyte cards had no data and were excluded from this verdict)' : '') +
    '</div></div>' +
    sections +
    '<div class="card"><p class="small">TEa source: CLIA 2024 Final Rule (CMS-3355-F), acceptable performance criteria enforced by PT providers beginning January 1, 2025, unless overridden above with a lab-defined limit. Data extracted from uploaded printouts via AI was not independently re-verified by this tool against the source document -- confirm accuracy before filing as a quality record.</p>' +
    sigGrid +
    '</div>';
}
