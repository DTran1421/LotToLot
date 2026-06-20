const supabase = require('./_supabase');

const VALID_SOURCES = ['CLIA', 'CAP', 'EFLM', 'Manufacturer', 'Lab-defined', 'Other'];
const VALID_MODES = ['pct', 'fixed', 'greater'];

function validate(body) {
  if (!body.analyte_name || !body.analyte_name.trim()) return 'analyte_name is required';
  if (!VALID_MODES.includes(body.mode)) return 'mode must be one of: ' + VALID_MODES.join(', ');
  if (!VALID_SOURCES.includes(body.source)) return 'source must be one of: ' + VALID_SOURCES.join(', ');
  if (body.mode === 'pct' && (body.pct === null || body.pct === undefined)) return 'pct is required for mode "pct"';
  if (body.mode === 'fixed' && (body.fixed === null || body.fixed === undefined)) return 'fixed is required for mode "fixed"';
  if (body.mode === 'greater' && (body.pct === null || body.pct === undefined || body.fixed === null || body.fixed === undefined)) {
    return 'both pct and fixed are required for mode "greater"';
  }
  return null;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('tea_criteria').select('*').order('analyte_name');
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const body = req.body;
      const err = validate(body);
      if (err) return res.status(400).json({ error: err });

      const aliases = Array.isArray(body.aliases) ? body.aliases.map((a) => a.trim().toLowerCase()).filter(Boolean) : [];
      const row = {
        analyte_name: body.analyte_name.trim(),
        aliases,
        unit: body.unit || null,
        mode: body.mode,
        pct: body.pct === '' ? null : body.pct,
        fixed: body.fixed === '' ? null : body.fixed,
        fixed_unit: body.fixed_unit || null,
        source: body.source,
        source_detail: body.source_detail || null,
        notes: body.notes || null,
        updated_at: new Date().toISOString(),
      };

      if (body.id) {
        const { data, error } = await supabase.from('tea_criteria').update(row).eq('id', body.id).select();
        if (error) throw error;
        return res.status(200).json(data[0]);
      } else {
        const { data, error } = await supabase.from('tea_criteria').insert(row).select();
        if (error) throw error;
        return res.status(200).json(data[0]);
      }
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id is required' });
      const { error } = await supabase.from('tea_criteria').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    res.status(405).json({ error: 'GET, POST, or DELETE only' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
