const supabase = require('./_supabase');

const COMPARISON_TOOL_URL = 'https://lot-to-lot.vercel.app/compare.html';
function buildComparisonUrl(instrument, category, item, oldLot, newLot) {
  const params = new URLSearchParams({
    instrument,
    category,
    analyte: item,
    oldLot: String(oldLot),
    newLot: String(newLot),
  });
  return COMPARISON_TOOL_URL + '?' + params.toString();
}

/**
 * Finalizes a pending lot-to-lot report. The client (browse.html) has
 * already generated the FINAL, reviewer-signed PDF (using report.js with
 * the reviewer's name/date baked in) and uploaded it -- this just records
 * that fact in both the permanent history row and the current-state row.
 *
 * payload: { historyId, instrument, category, item, verifiedBy, pdfUrl }
 */
async function handleApprove(req, res) {
  const { historyId, instrument, category, item, verifiedBy, pdfUrl } = req.body;
  if (!historyId || !instrument || !item || !verifiedBy || !pdfUrl) {
    return res.status(400).json({ error: 'historyId, instrument, item, verifiedBy, and pdfUrl are required' });
  }

  const dateVerified = new Date().toISOString();

  const { error: histErr } = await supabase
    .from('lot_to_lot_reports')
    .update({ status: 'Verified', verified_by: verifiedBy, date_verified: dateVerified, pdf_url: pdfUrl })
    .eq('id', historyId);
  if (histErr) throw histErr;

  const { error: masterErr } = await supabase
    .from('reagent_master')
    .update({ status: 'Verified', verified_by: verifiedBy, date_verified: dateVerified, report_pdf_url: pdfUrl })
    .eq('instrument', instrument)
    .eq('category', category)
    .eq('item', item);
  if (masterErr) throw masterErr;

  res.status(200).json({ success: true });
}

/**
 * Voids a lot-to-lot report -- e.g. it was submitted, or even approved, by
 * mistake. The row is NOT deleted: per the lab's existing documentation
 * practice (corrected reports get a visible "CORRECTED" indicator rather
 * than being silently edited), a voided report stays in the database with
 * who voided it, when, and why -- just excluded from being treated as the
 * active record for that item going forward.
 *
 * If the voided report was the most recently submitted (non-voided) one
 * for that instrument/category/item, reagent_master's current-state row
 * is rolled back to whatever the next most recent non-voided report says
 * (re-mirroring its status/performed_by/pdf/verified_by), or all the way
 * back to 'Pending verification' with a freshly rebuilt comparison link
 * if no other report exists -- since the underlying lot change still
 * genuinely needs a valid comparison on file. Voiding an OLDER report
 * that's since been superseded by a newer one leaves reagent_master
 * completely untouched, since its current state already reflects that
 * newer report, not this one.
 *
 * payload: { historyId, voidedBy, voidReason }
 */
async function handleVoid(req, res) {
  const { historyId, voidedBy, voidReason } = req.body;
  if (!historyId || !voidedBy || !voidedBy.trim()) {
    return res.status(400).json({ error: 'historyId and voidedBy are required' });
  }

  const { data: reportRows, error: fetchErr } = await supabase
    .from('lot_to_lot_reports')
    .select('*')
    .eq('id', historyId)
    .limit(1);
  if (fetchErr) throw fetchErr;
  if (!reportRows || reportRows.length === 0) {
    return res.status(404).json({ error: 'Report not found.' });
  }
  const report = reportRows[0];
  if (report.status === 'Voided') {
    return res.status(400).json({ error: 'This report is already voided.' });
  }

  // Was this the most recently submitted non-voided report for this
  // instrument/category/item? Determines whether reagent_master's CURRENT
  // state actually traces back to this specific report (and so needs to
  // be rolled back) or has already moved on to something newer.
  const { data: laterRows, error: laterErr } = await supabase
    .from('lot_to_lot_reports')
    .select('id')
    .eq('instrument', report.instrument)
    .eq('category', report.category)
    .eq('item', report.item)
    .neq('status', 'Voided')
    .gt('submitted_at', report.submitted_at)
    .limit(1);
  if (laterErr) throw laterErr;
  const wasCurrent = !laterRows || laterRows.length === 0;

  const { error: voidErr } = await supabase
    .from('lot_to_lot_reports')
    .update({
      status: 'Voided',
      voided_at: new Date().toISOString(),
      voided_by: voidedBy.trim(),
      void_reason: voidReason ? voidReason.trim() : null,
    })
    .eq('id', historyId);
  if (voidErr) throw voidErr;

  if (wasCurrent) {
    const { data: prevRows, error: prevErr } = await supabase
      .from('lot_to_lot_reports')
      .select('*')
      .eq('instrument', report.instrument)
      .eq('category', report.category)
      .eq('item', report.item)
      .neq('status', 'Voided')
      .order('submitted_at', { ascending: false })
      .limit(1);
    if (prevErr) throw prevErr;

    const masterUpdate = (prevRows && prevRows.length > 0)
      ? {
          status: prevRows[0].status,
          performed_by: prevRows[0].performed_by || '',
          report_pdf_url: prevRows[0].pdf_url || null,
          verified_by: prevRows[0].verified_by || '',
          date_verified: prevRows[0].date_verified || null,
          comparison_url: '',
        }
      : {
          status: 'Pending verification',
          performed_by: '',
          report_pdf_url: '',
          verified_by: '',
          date_verified: null,
          comparison_url: buildComparisonUrl(report.instrument, report.category, report.item, report.old_lot, report.new_lot),
        };

    const { error: masterErr } = await supabase
      .from('reagent_master')
      .update(masterUpdate)
      .eq('instrument', report.instrument)
      .eq('category', report.category)
      .eq('item', report.item);
    if (masterErr) throw masterErr;
  }

  res.status(200).json({ success: true, reagentMasterUpdated: wasCurrent });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (req.query.action === 'void') {
      return await handleVoid(req, res);
    }
    return await handleApprove(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
