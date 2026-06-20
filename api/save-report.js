const supabase = require('./_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { performedBy, pdfUrl, results } = req.body;
    if (!pdfUrl) return res.status(400).json({ error: 'pdfUrl is required' });
    if (!results || results.length === 0) return res.status(400).json({ error: 'results is required' });

    let updated = 0;
    for (const r of results) {
      const status = r.pass ? 'Pending Review' : 'Failed - needs investigation';
      const { error } = await supabase
        .from('reagent_master')
        .update({
          status,
          performed_by: performedBy || '',
          report_pdf_url: pdfUrl,
          comparison_url: '',
        })
        .eq('instrument', r.instrument)
        .eq('category', r.category)
        .eq('item', r.item);
      if (error) throw error;
      updated++;
    }

    res.status(200).json({ updated, pdfUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
