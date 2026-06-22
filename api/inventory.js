const supabase = require('./_supabase');

/**
 * Single consolidated endpoint for everything on the Inventory page.
 * Kept in one file (rather than separate inventory/orders/send-email
 * files) to stay under Vercel Hobby's serverless function count limit --
 * the project was already close to it before this page existed.
 *
 * GET  /api/inventory                       -> list inventory joined with catalog + order frequency
 * PATCH /api/inventory                      -> update in_stock / par_level / last_reviewed_at for one catalog_id
 * POST /api/inventory?action=create-order   -> create an order (+ order_log rows, + inventory bump)
 * GET  /api/inventory?action=list-orders    -> list past orders, most recent first
 * POST /api/inventory?action=send-email     -> email a generated order PDF via Resend
 * POST /api/inventory?action=reset-review   -> clear last_reviewed_at on every row (start a new count cycle)
 */
module.exports = async (req, res) => {
  try {
    const action = req.query.action;

    if (req.method === 'GET' && action === 'list-orders') {
      const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'GET') {
      const { data: rows, error } = await supabase
        .from('inventory')
        .select('*, catalog(id, analyzer, category, item, manufacturer_name, manufacturer_ref, mckesson_ref, mckesson_url, pack_size)')
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
        mckesson_url: r.catalog ? r.catalog.mckesson_url : null,
        pack_size: r.catalog ? r.catalog.pack_size : null,
        in_stock: r.in_stock,
        par_level: r.par_level,
        last_stock_update_at: r.last_stock_update_at,
        last_ordered_at: r.last_ordered_at,
        last_reviewed_at: r.last_reviewed_at,
        order_count: r.order_count,
        order_frequency: freqMap[r.catalog_id] || 0,
      }));

      return res.status(200).json(result);
    }

    if (req.method === 'PATCH') {
      const { catalog_id, in_stock, par_level, last_reviewed_at } = req.body;
      if (!catalog_id) return res.status(400).json({ error: 'catalog_id is required' });

      const update = {};
      if (in_stock !== undefined) {
        update.in_stock = in_stock;
        update.last_stock_update_at = new Date().toISOString();
      }
      if (par_level !== undefined) {
        update.par_level = par_level;
      }
      if (last_reviewed_at !== undefined) {
        update.last_reviewed_at = last_reviewed_at;
      }
      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'Nothing to update -- provide in_stock, par_level, and/or last_reviewed_at' });
      }

      const { data, error } = await supabase
        .from('inventory')
        .update(update)
        .eq('catalog_id', catalog_id)
        .select();
      if (error) throw error;
      return res.status(200).json(data[0]);
    }

    if (req.method === 'POST' && action === 'reset-review') {
      const { error } = await supabase
        .from('inventory')
        .update({ last_reviewed_at: null })
        .not('id', 'is', null);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (req.method === 'POST' && action === 'create-order') {
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

    if (req.method === 'POST' && action === 'send-email') {
      const { orderId, to, cc, subject, notes, pdfBase64, filename } = req.body;
      if (!orderId || !to || !pdfBase64 || !filename) {
        return res.status(400).json({ error: 'orderId, to, pdfBase64, and filename are required' });
      }

      if (!process.env.RESEND_API_KEY) {
        return res.status(500).json({
          error: 'RESEND_API_KEY is not set. Add it (and RESEND_FROM_EMAIL, on a domain verified with Resend) in the Vercel project\u2019s environment variables before auto-send will work. You can still download the PDF and send it manually in the meantime.',
        });
      }

      const fromAddress = process.env.RESEND_FROM_EMAIL || 'orders@resend.dev';

      const emailBody = {
        from: fromAddress,
        to: [to],
        subject: subject || 'Altru Diagnostics Order',
        text: (notes && notes.trim() ? notes.trim() + '\n\n' : '') + 'Please find the attached inventory order report.\n\n- Sent from the Altru Diagnostics Lot Tracking app',
        attachments: [{ filename, content: pdfBase64 }],
      };
      if (cc && cc.trim()) emailBody.cc = [cc.trim()];

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(emailBody),
      });

      if (!resendRes.ok) {
        const errText = await resendRes.text();
        throw new Error('Resend API error: ' + errText);
      }

      const sentAt = new Date().toISOString();
      const { error: updateErr } = await supabase
        .from('orders')
        .update({ sent_at: sentAt, sent_to: to, sent_cc: cc || null })
        .eq('id', orderId);
      if (updateErr) throw updateErr;

      return res.status(200).json({ success: true, sentAt });
    }

    res.status(405).json({ error: 'Unsupported method/action combination' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

