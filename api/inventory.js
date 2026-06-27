const supabase = require('./_supabase');
const nodemailer = require('nodemailer');

/**
 * Single consolidated endpoint for everything on the Inventory page.
 * Kept in one file (rather than separate inventory/orders/send-email
 * files) to stay under Vercel Hobby's serverless function count limit --
 * the project was already close to it before this page existed.
 *
 * GET  /api/inventory                       -> list inventory joined with catalog + order frequency
 * PATCH /api/inventory                      -> update in_stock / par_level / last_reviewed_at for one catalog_id
 * POST /api/inventory?action=create-order   -> create an order (+ order_log rows, + inventory bump), optionally save the generated PDF to Storage and set orders.pdf_url
 * GET  /api/inventory?action=list-orders    -> list past orders, most recent first
 * POST /api/inventory?action=send-email     -> email a generated order PDF via Gmail SMTP
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
        .select('*, catalog(id, analyzer, category, item, manufacturer_name, manufacturer_ref, mckesson_ref, mckesson_url, pack_size, storage_location)')
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
        storage_location: r.catalog ? r.catalog.storage_location : null,
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
        // Changing the count is itself proof you looked at the item, so
        // auto-mark it reviewed -- no need to also tap "Mark reviewed".
        update.last_reviewed_at = new Date().toISOString();
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
      const { items, notes, pdfBase64, filename } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items is required and must be a non-empty array' });
      }

      const { data: orderRows, error: orderErr } = await supabase
        .from('orders')
        .insert({ items, notes: notes || null })
        .select();
      if (orderErr) throw orderErr;
      const order = orderRows[0];

      // The "reports" Storage bucket already exists (public) but was never
      // actually wired up -- every past order has pdf_url: null. Save the
      // literal generated PDF here so Order History can link to the exact
      // file that was produced/sent, not a regeneration from the stored
      // items/notes (which could drift if catalog data changes later).
      if (pdfBase64) {
        const path = 'order_' + order.id + '.pdf';
        const { error: uploadErr } = await supabase.storage
          .from('reports')
          .upload(path, Buffer.from(pdfBase64, 'base64'), { contentType: 'application/pdf', upsert: true });
        if (uploadErr) {
          // Don't fail the whole order over a storage hiccup -- the order
          // itself (items/notes/inventory bump) still matters more than
          // the saved copy. pdf_url just stays null for this one.
          console.error('PDF upload failed for order', order.id, uploadErr.message);
        } else {
          const { data: urlData } = supabase.storage.from('reports').getPublicUrl(path);
          const { error: pdfUrlErr } = await supabase
            .from('orders')
            .update({ pdf_url: urlData.publicUrl })
            .eq('id', order.id);
          if (pdfUrlErr) throw pdfUrlErr;
          order.pdf_url = urlData.publicUrl;
        }
      }

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

      if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
        return res.status(500).json({
          error: 'GMAIL_USER and/or GMAIL_APP_PASSWORD are not set. Add both in the Vercel project\u2019s environment variables before auto-send will work (GMAIL_USER is the full Gmail address, GMAIL_APP_PASSWORD is a 16-character App Password generated from that Google account -- not its regular login password). You can still download the PDF and send it manually in the meantime.',
        });
      }

      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASSWORD,
        },
      });

      try {
        await transporter.sendMail({
          from: 'Altru Diagnostics Lot Tracking <' + process.env.GMAIL_USER + '>',
          to: to,
          cc: cc && cc.trim() ? cc.trim() : undefined,
          subject: subject || 'Altru Diagnostics Order',
          text: (notes && notes.trim() ? notes.trim() + '\n\n' : '') + 'Please find the attached inventory order report.\n\n- Sent from the Altru Diagnostics Lot Tracking app',
          attachments: [{ filename, content: pdfBase64, encoding: 'base64' }],
        });
      } catch (mailErr) {
        throw new Error('Gmail SMTP error: ' + mailErr.message);
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

