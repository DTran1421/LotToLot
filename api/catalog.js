const supabase = require('./_supabase');

/**
 * Consolidated endpoint for the Catalog table itself, plus the vendor
 * directory and per-item vendor pricing. Folded into this one file
 * (dispatched by ?action=) rather than new api/*.js files -- this
 * project hit Vercel Hobby's serverless function count limit before
 * and is already sitting right at it.
 *
 * GET  /api/catalog                       -> list catalog (unchanged)
 * POST /api/catalog                       -> create/update a catalog item (unchanged, now includes vendor)
 * DELETE /api/catalog?id=...              -> delete a catalog item (unchanged)
 *
 * GET    /api/catalog?action=vendors      -> list vendors
 * POST   /api/catalog?action=vendors      -> create/update a vendor
 * DELETE /api/catalog?action=vendors&id=  -> delete a vendor
 *
 * GET  /api/catalog?action=pricing        -> list catalog items joined with their vendor_pricing row
 * POST /api/catalog?action=pricing        -> upsert a single catalog_id's unit_price
 */
module.exports = async (req, res) => {
  try {
    const action = req.query.action;

    // ---------- Vendors ----------
    if (action === 'vendors') {
      if (req.method === 'GET') {
        const { data, error } = await supabase.from('vendors').select('*').order('name');
        if (error) throw error;
        return res.status(200).json(data);
      }

      if (req.method === 'POST') {
        const body = req.body;
        if (!body.name || !body.name.trim()) return res.status(400).json({ error: 'name is required' });

        const row = {
          name: body.name.trim(),
          order_email: body.order_email || null,
          order_cc: body.order_cc || null,
          ship_to: body.ship_to || null,
          bill_to: body.bill_to || null,
          price_required: !!body.price_required,
          notes: body.notes || null,
        };

        if (body.id) {
          const { data, error } = await supabase.from('vendors').update(row).eq('id', body.id).select();
          if (error) throw error;
          return res.status(200).json(data[0]);
        } else {
          const { data, error } = await supabase.from('vendors').insert(row).select();
          if (error) throw error;
          return res.status(200).json(data[0]);
        }
      }

      if (req.method === 'DELETE') {
        const id = req.query.id;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const { error } = await supabase.from('vendors').delete().eq('id', id);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }

      return res.status(405).json({ error: 'GET, POST, or DELETE only' });
    }

    // ---------- Vendor pricing ----------
    if (action === 'pricing') {
      if (req.method === 'GET') {
        const { data, error } = await supabase
          .from('catalog')
          .select('id, analyzer, category, item, vendor, manufacturer_ref, pack_size, vendor_pricing(unit_price, updated_at)')
          .order('vendor')
          .order('analyzer')
          .order('item');
        if (error) throw error;

        const result = data.map((r) => {
          // vendor_pricing.catalog_id is UNIQUE, so PostgREST treats this as
          // a 1-to-1 relationship and returns a single object -- not an
          // array like a normal one-to-many embed. Handle both shapes.
          const vp = r.vendor_pricing;
          const unitPrice = Array.isArray(vp) ? (vp[0] ? vp[0].unit_price : null) : (vp ? vp.unit_price : null);
          return {
            catalog_id: r.id,
            analyzer: r.analyzer,
            category: r.category,
            item: r.item,
            vendor: r.vendor,
            manufacturer_ref: r.manufacturer_ref,
            pack_size: r.pack_size,
            unit_price: unitPrice,
          };
        });
        return res.status(200).json(result);
      }

      if (req.method === 'POST') {
        const body = req.body;
        if (!body.catalog_id) return res.status(400).json({ error: 'catalog_id is required' });

        const { data, error } = await supabase
          .from('vendor_pricing')
          .upsert({ catalog_id: body.catalog_id, unit_price: body.unit_price === '' ? null : body.unit_price, updated_at: new Date().toISOString() }, { onConflict: 'catalog_id' })
          .select();
        if (error) throw error;
        return res.status(200).json(data[0]);
      }

      return res.status(405).json({ error: 'GET or POST only' });
    }

    // ---------- Catalog (default, unchanged shape) ----------
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('catalog').select('*').order('analyzer').order('category').order('item');
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const body = req.body;
      if (!body.analyzer || !body.analyzer.trim()) return res.status(400).json({ error: 'analyzer is required' });
      if (!body.item || !body.item.trim()) return res.status(400).json({ error: 'item is required' });
      if (!body.category || !body.category.trim()) return res.status(400).json({ error: 'category is required' });

      const row = {
        analyzer: body.analyzer.trim(),
        item: body.item.trim(),
        category: body.category.trim(),
        manufacturer_name: body.manufacturer_name || null,
        manufacturer_ref: body.manufacturer_ref || null,
        mckesson_ref: body.mckesson_ref || null,
        pack_size: body.pack_size || null,
        storage_temperature: body.storage_temperature || null,
        storage_location: body.storage_location || null,
        vendor: body.vendor && body.vendor.trim() ? body.vendor.trim() : 'McKesson',
      };

      if (body.id) {
        const { data, error } = await supabase.from('catalog').update(row).eq('id', body.id).select();
        if (error) throw error;
        return res.status(200).json(data[0]);
      } else {
        const { data, error } = await supabase.from('catalog').insert(row).select();
        if (error) throw error;
        return res.status(200).json(data[0]);
      }
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id is required' });
      const { error } = await supabase.from('catalog').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    res.status(405).json({ error: 'GET, POST, or DELETE only' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
