const supabase = require('./_supabase');

module.exports = async (req, res) => {
  try {
    const { data, error } = await supabase.from('catalog').select('analyzer');
    if (error) throw error;
    const instruments = [...new Set(data.map((r) => r.analyzer))].sort();
    res.status(200).json(instruments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
