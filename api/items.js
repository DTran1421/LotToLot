const supabase = require('./_supabase');

module.exports = async (req, res) => {
  try {
    const instrument = req.query.instrument;
    if (!instrument) return res.status(400).json({ error: 'instrument is required' });

    const { data, error } = await supabase
      .from('catalog')
      .select('item, category, reference_number')
      .eq('analyzer', instrument)
      .order('category')
      .order('item');
    if (error) throw error;

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
