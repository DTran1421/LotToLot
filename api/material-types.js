const supabase = require('./_supabase');

module.exports = async (req, res) => {
  try {
    const instrument = req.query.instrument;
    if (!instrument) return res.status(400).json({ error: 'instrument is required' });

    const { data, error } = await supabase
      .from('catalog')
      .select('category')
      .eq('analyzer', instrument);
    if (error) throw error;

    const categories = [...new Set(data.map((r) => r.category))].sort();
    res.status(200).json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
