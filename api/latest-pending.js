const supabase = require('./_supabase');

module.exports = async (req, res) => {
  try {
    const { instrument, category, item } = req.query;
    if (!instrument || !item) {
      return res.status(400).json({ error: 'instrument and item are required' });
    }
    const { data, error } = await supabase
      .from('lot_to_lot_reports')
      .select('*')
      .eq('instrument', instrument)
      .eq('category', category)
      .eq('item', item)
      .in('status', ['Pending Review', 'Failed - needs investigation'])
      .order('submitted_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'No pending report found for that item.' });
    }
    res.status(200).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
