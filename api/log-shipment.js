const supabase = require('./_supabase');

const FLAGGABLE_CATEGORIES = ['Reagent', 'Calibrator'];
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { instrument, category, item, ref, lotNumber, expirationDate, receivedBy, comments } = req.body;
    if (!instrument || !item || !lotNumber) {
      return res.status(400).json({ error: 'instrument, item, and lotNumber are required' });
    }

    const { data: existingRows, error: selErr } = await supabase
      .from('reagent_master')
      .select('*')
      .eq('instrument', instrument)
      .eq('category', category)
      .eq('item', item)
      .limit(1);
    if (selErr) throw selErr;

    let previousLot = '';
    let isNewLot = false;
    let status = '';
    let comparisonUrl = '';
    const flaggable = FLAGGABLE_CATEGORIES.includes(category);

    if (!existingRows || existingRows.length === 0) {
      // First time we've seen this instrument/category/item -- establish baseline, don't flag.
      const { error: insErr } = await supabase.from('reagent_master').insert({
        instrument,
        category,
        item,
        reference_number: ref || null,
        current_lot: lotNumber,
        last_received_date: new Date().toISOString(),
        status: 'N/A - initial lot on file',
      });
      if (insErr) throw insErr;
      previousLot = '(none on file)';
      status = 'N/A - initial lot';
    } else {
      const row = existingRows[0];
      previousLot = row.current_lot;
      if (String(previousLot || '').trim() !== String(lotNumber).trim()) {
        isNewLot = true;
        status = flaggable
          ? 'Pending verification'
          : 'New lot logged (no verification required for this category)';
        comparisonUrl = flaggable
          ? buildComparisonUrl(instrument, category, item, previousLot, lotNumber)
          : '';
        const { error: updErr } = await supabase
          .from('reagent_master')
          .update({
            current_lot: lotNumber,
            last_received_date: new Date().toISOString(),
            status,
            performed_by: '',
            report_pdf_url: '',
            verified_by: '',
            date_verified: null,
            comparison_url: comparisonUrl,
          })
          .eq('id', row.id);
        if (updErr) throw updErr;
      } else {
        status = 'Same lot - restock only';
        const { error: updErr } = await supabase
          .from('reagent_master')
          .update({ last_received_date: new Date().toISOString() })
          .eq('id', row.id);
        if (updErr) throw updErr;
      }
    }

    const { error: logErr } = await supabase.from('receiving_log').insert({
      received_by: receivedBy || '',
      instrument,
      category,
      item,
      reference_number: ref || null,
      lot_number: lotNumber,
      expiration_date: expirationDate || null,
      previous_lot: previousLot,
      is_new_lot: isNewLot,
      status,
      comments: comments || '',
    });
    if (logErr) throw logErr;

    res.status(200).json({ isNewLot, flaggable, status, previousLot, comparisonUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
