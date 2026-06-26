const supabase = require('./_supabase');

module.exports = async (req, res) => {
  try {
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
