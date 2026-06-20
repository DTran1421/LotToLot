const supabase = require('./_supabase');

// Allowlist only -- never pass the query param straight into a query builder
// or raw SQL. This is the one thing standing between a client-controlled
// string and arbitrary table access.
const TABLES = {
  catalog: { order: [['analyzer', false], ['item', false]], limit: 1000 },
  reagent_master: { order: [['instrument', false], ['item', false]], limit: 1000 },
  receiving_log: { order: [['logged_at', true]], limit: 500 },
  lot_to_lot_reports: { order: [['submitted_at', true]], limit: 1000 },
};

module.exports = async (req, res) => {
  try {
    const table = req.query.table;
    if (!table || !TABLES[table]) {
      return res.status(400).json({ error: 'table must be one of: ' + Object.keys(TABLES).join(', ') });
    }
    const cfg = TABLES[table];
    let query = supabase.from(table).select('*').limit(cfg.limit);
    cfg.order.forEach(([col, desc]) => {
      query = query.order(col, { ascending: !desc });
    });
    const { data, error } = await query;
    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
