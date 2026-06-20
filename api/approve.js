const supabase = require('./_supabase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { instrument, category, item, verifiedBy } = req.body;
    if (!instrument || !item || !verifiedBy) {
      return res.status(400).json({ error: 'instrument, item, and verifiedBy are required' });
    }
    const { error } = await supabase
      .from('reagent_master')
      .update({
        status: 'Verified',
        verified_by: verifiedBy,
        date_verified: new Date().toISOString(),
      })
      .eq('instrument', instrument)
      .eq('category', category)
      .eq('item', item);
    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
