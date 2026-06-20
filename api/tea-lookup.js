const supabase = require('./_supabase');

/**
 * Looks up a TEa entry by name: exact analyte_name match, then alias match,
 * then a loose "contains" match -- same fallback order the old hardcoded
 * lookupTea() used, just backed by a real table now.
 */
module.exports = async (req, res) => {
  try {
    const name = (req.query.analyte || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ error: 'analyte query param is required' });

    const { data: all, error } = await supabase.from('tea_criteria').select('*');
    if (error) throw error;

    let match = all.find((r) => r.analyte_name.toLowerCase() === name);
    if (!match) match = all.find((r) => (r.aliases || []).some((a) => a.toLowerCase() === name));
    if (!match) {
      match = all.find((r) => {
        const an = r.analyte_name.toLowerCase();
        if (an.includes(name) || name.includes(an)) return true;
        return (r.aliases || []).some((a) => a.toLowerCase().includes(name) || name.includes(a.toLowerCase()));
      });
    }

    if (!match) return res.status(404).json({ error: 'No TEa match found.' });
    res.status(200).json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
