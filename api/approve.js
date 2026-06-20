const supabase = require('./_supabase');

/**
 * Finalizes a pending lot-to-lot report. The client (browse.html) has
 * already generated the FINAL, reviewer-signed PDF (using report.js with
 * the reviewer's name/date baked in) and uploaded it -- this just records
 * that fact in both the permanent history row and the current-state row.
 *
 * payload: { historyId, instrument, category, item, verifiedBy, pdfUrl }
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
