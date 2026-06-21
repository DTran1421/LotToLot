const supabase = require('./_supabase');

/**
 * POST: creates a new order from a list of items (each carrying the catalog_id
 * and qty the tech wants to order). Stores a permanent snapshot in `orders`,
 * appends one row per item to `order_log` (this is what powers Order
 * Frequency), and updates each item's `last_ordered_at` / `order_count` in
 * `inventory`. Mirrors generateOrderReport() from the old Apps Script, minus
 * the spreadsheet sorting/report-sheet-creation, which the UI now handles.
 *
 * payload: { items: [{catalog_id, analyzer, category, item, manufacturer_ref, mckesson_ref, qty}], notes }
 *
 * GET: lists past orders, most recent first.
 */
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      const { items, notes } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items is required and must be a non-empty array' });
      }

      const { data: orderRows, error: orderErr } = await supabase
        .from('orders')
        .insert({ items, notes: notes || null })
        .select();
      if (orderErr) throw orderErr;
      const order = orderRows[0];

      const now = new Date().toISOString();
      const logRows = items.map((it) => ({ catalog_id: it.catalog_id, order_id: order.id, ordered_at: now }));
      const { error: logErr } = await supabase.from('order_log').insert(logRows);
      if (logErr) throw logErr;

      for (const it of items) {
        const { data: currentRows, error: fetchErr } = await supabase
          .from('inventory')
          .select('order_count')
          .eq('catalog_id', it.catalog_id)
          .single();
        if (fetchErr) throw fetchErr;

        const { error: updateErr } = await supabase
          .from('inventory')
          .update({
            last_ordered_at: now,
            order_count: (currentRows.order_count || 0) + 1,
          })
          .eq('catalog_id', it.catalog_id);
        if (updateErr) throw updateErr;
      }

      return res.status(200).json(order);
    }

    if (req.method === 'GET') {
      const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return res.status(200).json(data);
    }

    res.status(405).json({ error: 'GET or POST only' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
