const supabase = require('./_supabase');

/**
 * GET: returns every inventory row joined with its catalog item (analyzer,
 * category, item, manufacturer/McKesson refs) plus order frequency, computed
 * from order_log. One row per catalog item -- inventory rows are seeded for
 * all catalog items at migration time and there's a 1:1 relationship.
 *
 * PATCH: updates in_stock and/or par_level for a single catalog_id.
 * Auto-stamps last_stock_update_at server-side whenever in_stock changes,
 * mirroring the old onEdit() trigger that stamped a "last updated" column
 * whenever the In Stock cell was touched.
 */
module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const { data: rows, error } = await supabase
        .from('inventory')
        .select('*, catalog(id, analyzer, category, item, manufacturer_name, manufacturer_ref, mckesson_ref)')
        .order('catalog_id');
      if (error) throw error;

      const { data: logRows, error: logErr } = await supabase.from('order_log').select('catalog_id');
      if (logErr) throw logErr;

      const freqMap = {};
      for (const r of logRows) {
        freqMap[r.catalog_id] = (freqMap[r.catalog_id] || 0) + 1;
      }

      const result = rows.map((r) => ({
        catalog_id: r.catalog_id,
        analyzer: r.catalog ? r.catalog.analyzer : null,
        category: r.catalog ? r.catalog.category : null,
        item: r.catalog ? r.catalog.item : null,
        manufacturer_name: r.catalog ? r.catalog.manufacturer_name : null,
        manufacturer_ref: r.catalog ? r.catalog.manufacturer_ref : null,
        mckesson_ref: r.catalog ? r.catalog.mckesson_ref : null,
        in_stock: r.in_stock,
        par_level: r.par_level,
        last_stock_update_at: r.last_stock_update_at,
        last_ordered_at: r.last_ordered_at,
        order_count: r.order_count,
        order_frequency: freqMap[r.catalog_id] || 0,
      }));

      return res.status(200).json(result);
    }

    if (req.method === 'PATCH') {
      const { catalog_id, in_stock, par_level } = req.body;
      if (!catalog_id) return res.status(400).json({ error: 'catalog_id is required' });

      const update = {};
      if (in_stock !== undefined) {
        update.in_stock = in_stock;
        update.last_stock_update_at = new Date().toISOString();
      }
      if (par_level !== undefined) {
        update.par_level = par_level;
      }
      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'Nothing to update -- provide in_stock and/or par_level' });
      }

      const { data, error } = await supabase
        .from('inventory')
        .update(update)
        .eq('catalog_id', catalog_id)
        .select();
      if (error) throw error;
      return res.status(200).json(data[0]);
    }

    res.status(405).json({ error: 'GET or PATCH only' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
