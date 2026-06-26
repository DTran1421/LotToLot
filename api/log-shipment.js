const supabase = require('./_supabase');

// Per lab policy: lot-to-lot comparisons are only performed on Reagents.
// Other categories (Calibrator, Control, Chemical, Equipment, Misc, Linearity)
// still get logged for traceability, but won't flag "Pending verification."
const FLAGGABLE_CATEGORIES = ['Reagent'];
const COMPARISON_TOOL_URL = 'https://lot-to-lot.vercel.app/compare.html';

function buildComparisonUrl(instrument, category, item, oldLot, newLot) {
  const params = new URLSearchParams({
    instrument,
    category,
    analyte: item,
    oldLot: String(oldLot),
    newLot: String(newLot),
  });
  return COMPARISON_TOOL_URL + '?' + params.toString();
}

async function handleLogShipment(req, res) {
  const {
    instrument, category, item, manufacturerRef, mckessonRef,
    lotNumber, quantity, expirationDate, receivedBy, comments,
  } = req.body;
  if (!instrument || !item || !lotNumber) {
    return res.status(400).json({ error: 'instrument, item, and lotNumber are required' });
  }

  const { data: existingRows, error: selErr } = await supabase
    .from('reagent_master')
    .select('*')
    .eq('instrument', instrument)
    .eq('category', category)
    .eq('item', item)
    .limit(1);
  if (selErr) throw selErr;

  let previousLot = '';
  let isNewLot = false;
  let status = '';
  let comparisonUrl = '';
  const flaggable = FLAGGABLE_CATEGORIES.includes(category);

  if (!existingRows || existingRows.length === 0) {
    // First time we've seen this instrument/category/item -- establish baseline, don't flag.
    const { error: insErr } = await supabase.from('reagent_master').insert({
      instrument,
      category,
      item,
      manufacturer_ref: manufacturerRef || null,
      mckesson_ref: mckessonRef || null,
      current_lot: lotNumber,
      last_received_date: new Date().toISOString(),
      status: 'N/A - initial lot on file',
    });
    if (insErr) throw insErr;
    previousLot = '(none on file)';
    status = 'N/A - initial lot';
  } else {
    const row = existingRows[0];
    previousLot = row.current_lot;
    if (String(previousLot || '').trim() !== String(lotNumber).trim()) {
      isNewLot = true;
      status = flaggable
        ? 'Pending verification'
        : 'New lot logged (no verification required for this category)';
      comparisonUrl = flaggable
        ? buildComparisonUrl(instrument, category, item, previousLot, lotNumber)
        : '';
      const { error: updErr } = await supabase
        .from('reagent_master')
        .update({
          current_lot: lotNumber,
          last_received_date: new Date().toISOString(),
          status,
          performed_by: '',
          report_pdf_url: '',
          verified_by: '',
          date_verified: null,
          comparison_url: comparisonUrl,
        })
        .eq('id', row.id);
      if (updErr) throw updErr;
    } else {
      status = 'Same lot - restock only';
      const { error: updErr } = await supabase
        .from('reagent_master')
        .update({ last_received_date: new Date().toISOString() })
        .eq('id', row.id);
      if (updErr) throw updErr;
    }
  }

  const { error: logErr } = await supabase.from('receiving_log').insert({
    received_by: receivedBy || '',
    instrument,
    category,
    item,
    manufacturer_ref: manufacturerRef || null,
    mckesson_ref: mckessonRef || null,
    lot_number: lotNumber,
    quantity: quantity || null,
    expiration_date: expirationDate || null,
    previous_lot: previousLot,
    is_new_lot: isNewLot,
    status,
    comments: comments || '',
  });
  if (logErr) throw logErr;

  res.status(200).json({ isNewLot, flaggable, status, previousLot, comparisonUrl });
}

/**
 * Server-side AI proxy for bulk-extracting line items from an uploaded
 * shipping manifest / packing slip, so a whole delivery can be logged at
 * once instead of one item at a time through the dropdowns. Same security
 * pattern as the Lot Comparison page's extraction proxy (api/tea-lookup.js):
 * the file goes from the browser straight to this endpoint, the Anthropic
 * API key and the extraction prompt both stay server-side, reading
 * ANTHROPIC_API_KEY from a private Vercel env var. Returns raw extracted
 * line items only -- matching them against the actual catalog happens
 * client-side in index.html, since that's where the full catalog list and
 * the review/confirm UI live.
 */
async function handleExtractManifest(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set. Add it in the Vercel project\u2019s environment variables (get a key from console.anthropic.com) before manifest extraction will work.',
    });
  }

  const { base64, mediaType, isPdf } = req.body;
  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'base64 and mediaType are required' });
  }

  const instructions = `This is a shipping manifest, packing slip, or invoice for clinical lab reagents, calibrators, or supplies. Extract every distinct line item on it.

For each line item, return:
- itemDescription: the product name/description exactly as printed
- referenceNumber: any catalog #, REF #, Cat. No., SKU, or manufacturer item number printed for that line -- this is the most reliable identifier, include it whenever visible
- lotNumber: the lot number for that line item, if printed
- quantity: the quantity received/shipped for that line, as a plain number with no units
- expirationDate: the expiration date for that line in YYYY-MM-DD format if you can determine it, otherwise exactly as printed

Return ONLY raw JSON (no markdown fences, no commentary) in this exact shape:
{"items":[{"itemDescription":"<text>","referenceNumber":"<text or null>","lotNumber":"<text or null>","quantity":<number or null>,"expirationDate":"<text or null>"}]}

Use null for any field that isn't present or legible for a given line. If you find no line items at all, return {"items":[]}.`;

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: instructions }] }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error((data.error && data.error.message) || ('Anthropic API error (status ' + response.status + ')'));
  }
  res.status(200).json(data);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (req.query.action === 'extract-manifest') {
      return await handleExtractManifest(req, res);
    }
    return await handleLogShipment(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
