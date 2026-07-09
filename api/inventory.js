const supabase = require('./_supabase');
const nodemailer = require('nodemailer');

/**
 * Single consolidated endpoint for everything on the Inventory page.
 * Kept in one file (rather than separate inventory/orders/send-email
 * files) to stay under Vercel Hobby's serverless function count limit --
 * the project was already close to it before this page existed.
 *
 * GET  /api/inventory                       -> list inventory joined with catalog + vendor + unit price + order frequency (now includes reviewed_by, last_ordered_by)
 * PATCH /api/inventory                      -> update in_stock / par_level / last_reviewed_at (+ optional reviewed_by) for one catalog_id
 * POST /api/inventory?action=create-order   -> create an order (+ order_log rows, + inventory bump); assigns a PO number for non-McKesson vendors. No PDF yet -- see attach-pdf. Pass test:true to preview (no writes at all, PO number prefixed TEST- and never reserved).
 * POST /api/inventory?action=attach-pdf     -> save the client-generated PDF (which needed the PO number from create-order) to Storage and set orders.pdf_url. Skip entirely in test mode -- there's no real order row to attach to.
 * GET  /api/inventory?action=list-orders    -> list past orders, most recent first
 * POST /api/inventory?action=send-email     -> email a generated order PDF via Gmail SMTP
 * POST /api/inventory?action=reset-review   -> clear last_reviewed_at on every row (start a new count cycle)
 * POST /api/inventory?action=save-catalog-sheet     -> save a client-generated "Print Catalog Sheet" PDF to Storage + catalog_sheet_history (cloud-only, no local download)
 * GET  /api/inventory?action=catalog-sheet-history  -> list past catalog sheet generations, most recent first
 */
module.exports = async (req, res) => {
  try {
    const action = req.query.action;

    if (req.method === 'GET' && action === 'list-orders') {
      const { data, error } = await supabase.from('orders').select('*').neq('hidden', true).order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'GET' && action === 'catalog-sheet-history') {
      const { data, error } = await supabase.from('catalog_sheet_history').select('*').order('generated_at', { ascending: false }).limit(100);
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'GET') {
      const { data: rows, error } = await supabase
        .from('inventory')
        .select('*, catalog(id, analyzer, category, item, manufacturer_name, manufacturer_ref, mckesson_ref, mckesson_url, pack_size, storage_location, storage_temperature, vendor, vendor_pricing(unit_price))')
        .order('catalog_id');
      if (error) throw error;

      const { data: logRows, error: logErr } = await supabase.from('order_log').select('catalog_id');
      if (logErr) throw logErr;

      const freqMap = {};
      for (const r of logRows) {
        freqMap[r.catalog_id] = (freqMap[r.catalog_id] || 0) + 1;
      }

      const result = rows.map((r) => {
        // vendor_pricing.catalog_id is UNIQUE, so PostgREST treats this as
        // a 1-to-1 relationship and returns a single object -- not an
        // array like a normal one-to-many embed. Handle both shapes.
        const vp = r.catalog ? r.catalog.vendor_pricing : null;
        const unitPrice = Array.isArray(vp) ? (vp[0] ? vp[0].unit_price : null) : (vp ? vp.unit_price : null);
        return {
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
          storage_temperature: r.catalog ? r.catalog.storage_temperature : null,
          vendor: r.catalog ? r.catalog.vendor : null,
          unit_price: unitPrice,
          in_stock: r.in_stock,
          par_level: r.par_level,
          last_stock_update_at: r.last_stock_update_at,
          last_ordered_at: r.last_ordered_at,
          last_ordered_by: r.last_ordered_by,
          last_reviewed_at: r.last_reviewed_at,
          reviewed_by: r.reviewed_by,
          order_count: r.order_count,
          order_frequency: freqMap[r.catalog_id] || 0,
        };
      });

      return res.status(200).json(result);
    }

    if (req.method === 'PATCH') {
      const { catalog_id, in_stock, par_level, last_reviewed_at, reviewed_by } = req.body;
      if (!catalog_id) return res.status(400).json({ error: 'catalog_id is required' });

      const update = {};
      if (in_stock !== undefined) {
        update.in_stock = in_stock;
        update.last_stock_update_at = new Date().toISOString();
        // Changing the count is itself proof you looked at the item, so
        // auto-mark it reviewed -- no need to also tap "Mark reviewed".
        update.last_reviewed_at = new Date().toISOString();
        update.reviewed_by = reviewed_by || null;
      }
      if (par_level !== undefined) {
        update.par_level = par_level;
      }
      if (last_reviewed_at !== undefined) {
        update.last_reviewed_at = last_reviewed_at;
        update.reviewed_by = last_reviewed_at ? (reviewed_by || null) : null; // clear the name too when un-marking
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
      const { items, notes, vendor, test, orderedBy } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items is required and must be a non-empty array' });
      }

      const vendorName = vendor || 'McKesson';

      // McKesson orders have never used a PO number and Order History
      // shouldn't suddenly grow one for them. Every other vendor gets one
      // auto-generated as MMDDYYYY of today, with a -2/-3/... suffix if
      // this vendor already has an order with that same base number today
      // -- guarantees uniqueness without relying on client-side timing.
      let poNumber = null;
      if (vendorName !== 'McKesson') {
        const now = new Date();
        const base = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + now.getFullYear();
        const { data: existing, error: poErr } = await supabase
          .from('orders')
          .select('po_number')
          .eq('vendor', vendorName)
          .like('po_number', base + '%');
        if (poErr) throw poErr;
        const existingNumbers = (existing || []).map((r) => r.po_number).filter(Boolean);
        if (existingNumbers.length === 0) {
          poNumber = base;
        } else {
          let suffix = 2;
          while (existingNumbers.indexOf(base + '-' + suffix) !== -1) suffix++;
          poNumber = base + '-' + suffix;
        }
      }

      // Test mode: preview exactly what a real order would look like --
      // including a realistic PO number -- without writing anything.
      // Nothing is inserted into orders/order_log, no inventory bump, and
      // the PO number above is never actually reserved (a real order
      // placed afterward can still claim it). Prefixed with TEST- so it's
      // unmistakable if it ever ends up on a screenshot or printout.
      if (test) {
        return res.status(200).json({
          id: null,
          test: true,
          vendor: vendorName,
          po_number: poNumber ? 'TEST-' + poNumber : null,
        });
      }

      const { data: orderRows, error: orderErr } = await supabase
        .from('orders')
        .insert({ items, notes: notes || null, vendor: vendorName, po_number: poNumber, ordered_by: orderedBy || null })
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
            last_ordered_by: orderedBy || null,
            order_count: (currentRows.order_count || 0) + 1,
          })
          .eq('catalog_id', it.catalog_id);
        if (updateErr) throw updateErr;
      }

      return res.status(200).json(order);
    }

    // Step 2, called once the client has generated the actual PDF (which
    // needed order.po_number from step 1 to print on a non-McKesson PO).
    // The "reports" Storage bucket already exists (public) -- this just
    // saves the literal generated PDF so Order History can link to the
    // exact file that was produced/sent, not a regeneration from the
    // stored items/notes (which could drift if catalog data changes later).
    if (req.method === 'POST' && action === 'attach-pdf') {
      const { orderId, pdfBase64, filename } = req.body;
      if (!orderId || !pdfBase64) return res.status(400).json({ error: 'orderId and pdfBase64 are required' });

      const path = 'order_' + orderId + '.pdf';
      const { error: uploadErr } = await supabase.storage
        .from('reports')
        .upload(path, Buffer.from(pdfBase64, 'base64'), { contentType: 'application/pdf', upsert: true });
      if (uploadErr) throw uploadErr;

      const { data: urlData } = supabase.storage.from('reports').getPublicUrl(path);
      const { error: pdfUrlErr } = await supabase
        .from('orders')
        .update({ pdf_url: urlData.publicUrl })
        .eq('id', orderId);
      if (pdfUrlErr) throw pdfUrlErr;

      return res.status(200).json({ pdf_url: urlData.publicUrl });
    }

    // "Print Catalog Sheet" on the Inventory page is cloud-only by design
    // (no local download) -- the generated PDF is saved straight to the
    // same public "reports" Storage bucket used for order PDFs, with a
    // history row so it's browsable from the Catalog Sheets tab.
    if (req.method === 'POST' && action === 'save-catalog-sheet') {
      const { pdfBase64, generatedBy, itemCount, filterSummary } = req.body;
      if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 is required' });

      const path = 'catalog-sheet_' + Date.now() + '.pdf';
      const { error: uploadErr } = await supabase.storage
        .from('reports')
        .upload(path, Buffer.from(pdfBase64, 'base64'), { contentType: 'application/pdf' });
      if (uploadErr) throw uploadErr;

      const { data: urlData } = supabase.storage.from('reports').getPublicUrl(path);

      const { data: historyRow, error: historyErr } = await supabase
        .from('catalog_sheet_history')
        .insert({
          generated_by: generatedBy || null,
          item_count: itemCount || null,
          filter_summary: filterSummary || null,
          pdf_url: urlData.publicUrl,
        })
        .select()
        .single();
      if (historyErr) throw historyErr;

      return res.status(200).json(historyRow);
    }

    if (req.method === 'POST' && action === 'send-email') {
      const { orderId, to, cc, subject, notes, pdfBase64, filename } = req.body;
      if (!to || !pdfBase64 || !filename) {
        return res.status(400).json({ error: 'to, pdfBase64, and filename are required' });
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
          replyTo: 'David Tran <david.tran@medscanlab.com>',
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
      if (orderId) {
        const { error: updateErr } = await supabase
          .from('orders')
          .update({ sent_at: sentAt, sent_to: to, sent_cc: cc || null })
          .eq('id', orderId);
        if (updateErr) throw updateErr;
      }

      return res.status(200).json({ success: true, sentAt });
    }

    res.status(405).json({ error: 'Unsupported method/action combination' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

