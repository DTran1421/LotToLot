const supabase = require('./_supabase');

/**
 * Called from the comparison tool's "Save report & submit for review" button.
 * This does NOT generate or store a final PDF -- it records the raw results
 * data so the FINAL, reviewer-signed PDF can be generated later at approval
 * time (see api/approve.js). This guarantees the permanent PDF always
 * reflects who reviewed it and when, rather than being finalized before
 * review happens.
 *
 * payload: { job: {...}, cards: [{analyteName, category, oldLot, newLot, calc, ...}] }
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { job, cards } = req.body;
    if (!job || !cards || cards.length === 0) {
      return res.status(400).json({ error: 'job and cards are required' });
    }

    const qualifying = cards.filter((c) => c.calc && c.category && job.instrument);
    if (qualifying.length === 0) {
      return res.status(400).json({
        error: "None of these analytes have a Category set, so there's nothing to write back. Set Category on each card, or use a Start verification link.",
      });
    }

    let inserted = 0;
    for (const c of qualifying) {
      const status = c.calc.pass ? 'Pending Review' : 'Failed - needs investigation';

      const { error: histErr } = await supabase.from('lot_to_lot_reports').insert({
        instrument: job.instrument,
        category: c.category,
        item: c.analyteName,
        old_lot: c.oldLot || null,
        new_lot: c.newLot || null,
        pass: c.calc.pass,
        performed_by: job.performedBy || '',
        status,
        report_data: { job, card: c },
      });
      if (histErr) throw histErr;

      const { error: masterErr } = await supabase
        .from('reagent_master')
        .update({
          status,
          performed_by: job.performedBy || '',
          report_pdf_url: null, // no final PDF yet -- set at approval time
          comparison_url: '',
        })
        .eq('instrument', job.instrument)
        .eq('category', c.category)
        .eq('item', c.analyteName);
      if (masterErr) throw masterErr;

      inserted++;
    }

    res.status(200).json({ inserted, items: qualifying.map((c) => c.analyteName) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
