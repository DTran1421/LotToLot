const supabase = require('./_supabase');

module.exports = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reagent_master')
      .select('*')
      .in('status', ['Pending Review', 'Failed - needs investigation', 'Pending verification'])
      .order('last_received_date', { ascending: false });
    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
