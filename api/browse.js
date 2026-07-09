const supabase = require('./_supabase');

// Allowlist only -- never pass the query param straight into a query builder
// or raw SQL. This is the one thing standing between a client-controlled
// string and arbitrary table access.
const TABLES = {
  catalog: { order: [['analyzer', false], ['category', false], ['item', false]], limit: 1000 },
  reagent_master: { order: [['instrument', false], ['item', false]], limit: 1000 },
  receiving_log: {
    order: [['logged_at', true]],
    limit: 500,
    select: '*, manifest_uploads(file_url, filename)',
  },
  lot_to_lot_reports: { order: [['submitted_at', true]], limit: 1000 },
};

/* -----------------------------------------------------------------------
 * Raw data file attachments (?action=raw-data)
 * The actual file bytes are uploaded directly from the browser straight to
 * Supabase Storage (same pattern browse.html already uses for final report
 * PDFs) -- this just records/serves the metadata, and resolves a matching
 * reagent_master row when one exists so the same attachment shows up
 * whether you're looking at it from Browse Data or the Lot Comparison page.
 * Kept in this file rather than a new one to avoid Vercel's Hobby plan
 * serverless function cap, which this project has hit before.
 * --------------------------------------------------------------------- */
async function handleRawData(req, res) {
  if (req.method === 'GET') {
    const { reagent_master_id, instrument, category, item } = req.query;
    let query = supabase.from('raw_data_files').select('*').order('uploaded_at', { ascending: false });
    if (reagent_master_id) {
      query = query.eq('reagent_master_id', reagent_master_id);
    } else if (instrument && category && item) {
      query = query.eq('instrument', instrument).eq('category', category).eq('item', item);
    } else {
      return res.status(400).json({ error: 'Provide reagent_master_id, or instrument+category+item' });
    }
    const { data, error } = await query;
    if (error) throw error;
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { instrument, category, item, filename, fileUrl, fileSize, contentType, uploadedBy } = req.body;
    if (!filename || !fileUrl) {
      return res.status(400).json({ error: 'filename and fileUrl are required' });
    }

    let reagentMasterId = null;
    if (instrument && category && item) {
      const { data: matchRows } = await supabase
        .from('reagent_master')
        .select('id')
        .eq('instrument', instrument)
        .eq('category', category)
        .eq('item', item)
        .limit(1);
      if (matchRows && matchRows.length > 0) reagentMasterId = matchRows[0].id;
    }

    const { data, error } = await supabase
      .from('raw_data_files')
      .insert({
        reagent_master_id: reagentMasterId,
        instrument: instrument || null,
        category: category || null,
        item: item || null,
        filename,
        file_url: fileUrl,
        file_size: fileSize || null,
        content_type: contentType || null,
        uploaded_by: uploadedBy || null,
      })
      .select();
    if (error) throw error;
    return res.status(200).json(data[0]);
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const { data: rows, error: selErr } = await supabase.from('raw_data_files').select('*').eq('id', id).limit(1);
    if (selErr) throw selErr;
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const row = rows[0];
    const marker = '/object/public/raw-data/';
    const idx = row.file_url.indexOf(marker);
    if (idx !== -1) {
      const storagePath = decodeURIComponent(row.file_url.slice(idx + marker.length));
      const { error: rmErr } = await supabase.storage.from('raw-data').remove([storagePath]);
      if (rmErr) console.error('Storage removal failed for', storagePath, rmErr.message);
    }

    const { error: delErr } = await supabase.from('raw_data_files').delete().eq('id', id);
    if (delErr) throw delErr;
    return res.status(200).json({ success: true });
  }

  res.status(405).json({ error: 'Unsupported method for action=raw-data' });
}

module.exports = async (req, res) => {
  try {
    if (req.query.action === 'raw-data') {
      return await handleRawData(req, res);
    }

    // Expected vs. received view for the Order Fulfillment tab in Browse Data.
    // Pulls all explicitly placed orders from the last 90 days, computes an
    // expected delivery date per order using the lab's vendor delivery rules,
    // then infers fulfillment by matching receiving_log entries on
    // manufacturer_ref after the order date.
    //
    // Delivery rules (vendor doesn't operate weekends, Mondays are slow):
    //   Mon ordered → expect Thu (+ 3 days)
    //   Tue ordered → expect Fri (+ 3 days)
    //   Wed ordered → expect Fri (+ 2 days)
    //   Thu ordered → expect following Tue (+ 5 days)
    //   Fri ordered → expect following Tue (+ 4 days)
    const DAYS_TO_ADD = [2, 3, 3, 2, 5, 4, 3]; // index by getDay() (Sun=0..Sat=6)

    if (req.query.action === 'order-fulfillment') {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);

      const { data: orders, error: ordErr } = await supabase
        .from('orders')
        .select('id, created_at, vendor, po_number, ordered_by, sent_at, sent_to, items, pdf_url')
        .gte('created_at', cutoff.toISOString())
        .neq('hidden', true)
        .order('created_at', { ascending: false });
      if (ordErr) throw ordErr;

      const { data: receipts, error: recErr } = await supabase
        .from('receiving_log')
        .select('id, logged_at, item, manufacturer_ref, lot_number, quantity, received_by, instrument, category')
        .gte('logged_at', cutoff.toISOString())
        .order('logged_at', { ascending: false });
      if (recErr) throw recErr;

      const now = new Date();
      now.setHours(0, 0, 0, 0);

      const result = orders.map(order => {
        const orderDate = new Date(order.created_at);
        orderDate.setHours(0, 0, 0, 0);
        const expectedBy = new Date(orderDate);
        expectedBy.setDate(orderDate.getDate() + DAYS_TO_ADD[orderDate.getDay()]);

        const lineItems = (order.items || []).map(lineItem => {
          // Match receipts by manufacturer_ref, received after order placed
          // and within 21 days (3 weeks -- anything later is a different order cycle).
          const matched = receipts.filter(r =>
            r.manufacturer_ref === lineItem.manufacturer_ref &&
            new Date(r.logged_at) > new Date(order.created_at) &&
            new Date(r.logged_at).getTime() - new Date(order.created_at).getTime() <= 21 * 86400000
          );

          let status;
          if (matched.length > 0)        status = 'received';
          else if (now <= expectedBy)     status = 'pending';
          else                            status = 'overdue';

          return {
            catalog_id:       lineItem.catalog_id,
            item:             lineItem.item,
            analyzer:         lineItem.analyzer,
            category:         lineItem.category,
            manufacturer_ref: lineItem.manufacturer_ref,
            pack_size:        lineItem.pack_size,
            qty:              lineItem.qty,
            status,
            receipts: matched.map(r => ({
              id:           r.id,
              logged_at:    r.logged_at,
              lot_number:   r.lot_number,
              quantity:     r.quantity,
              received_by:  r.received_by,
            })),
          };
        });

        const receivedCount = lineItems.filter(l => l.status === 'received').length;
        const overdueCount  = lineItems.filter(l => l.status === 'overdue').length;

        return {
          id:           order.id,
          created_at:   order.created_at,
          vendor:       order.vendor,
          po_number:    order.po_number,
          ordered_by:   order.ordered_by,
          sent_at:      order.sent_at,
          pdf_url:      order.pdf_url,
          expectedBy:   expectedBy.toISOString(),
          lineItems,
          receivedCount,
          overdueCount,
          totalCount:   lineItems.length,
        };
      });

      return res.status(200).json(result);
    }

    const table = req.query.table;
    if (!table || !TABLES[table]) {
      return res.status(400).json({ error: 'table must be one of: ' + Object.keys(TABLES).join(', ') });
    }
    const cfg = TABLES[table];
    let query = supabase.from(table).select(cfg.select || '*').limit(cfg.limit);
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
