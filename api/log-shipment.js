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
    lotNumber, quantity, expirationDate, receivedBy, comments, manifestUploadId,
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
    manifest_upload_id: manifestUploadId || null,
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

/**
 * "Needs Review" queue (Browse Data's Needs Review tab) -- holds manifest
 * line items that couldn't be confidently matched (or weren't resolved by
 * the time "Log shipments" was clicked) so nothing extracted from a
 * manifest ever just silently disappears the way it used to. Folded into
 * this file rather than a new one -- this project hit Vercel Hobby's
 * serverless function count limit before and is already sitting right at
 * it. Resolving a queued row (matching it to an existing or newly-created
 * catalog item) still goes through the normal handleLogShipment() above --
 * this is purely the holding queue itself.
 */
async function handleReviewQueueGet(req, res) {
  const { data, error } = await supabase
    .from('manifest_review_queue')
    .select('*, manifest_uploads(file_url, filename)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  res.status(200).json(data);
}

async function handleReviewQueuePost(req, res) {
  const { extracted, lotNumber, quantity, expirationDate, receivedBy, manifestUploadId } = req.body;
  if (!extracted) return res.status(400).json({ error: 'extracted is required' });

  const { data, error } = await supabase
    .from('manifest_review_queue')
    .insert({
      extracted,
      lot_number: lotNumber || null,
      quantity: quantity != null ? String(quantity) : null,
      expiration_date: expirationDate || null,
      received_by: receivedBy || null,
      manifest_upload_id: manifestUploadId || null,
    })
    .select();
  if (error) throw error;
  res.status(200).json(data[0]);
}

async function handleReviewQueuePatch(req, res) {
  const { id, status, resolvedCatalogId } = req.body;
  if (!id || !status) return res.status(400).json({ error: 'id and status are required' });
  if (!['pending', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: "status must be 'pending', 'resolved', or 'dismissed'" });
  }

  const row = {
    status,
    resolved_catalog_id: resolvedCatalogId || null,
    resolved_at: status === 'pending' ? null : new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('manifest_review_queue')
    .update(row)
    .eq('id', id)
    .select();
  if (error) throw error;
  res.status(200).json(data[0]);
}

/**
 * Records the metadata row for a manifest file that was just uploaded
 * directly from the browser to Supabase Storage (same direct-to-storage
 * pattern as raw-data.js's attachments -- the file itself never touches
 * this serverless function, only its resulting public URL does). Every
 * receiving_log row and manifest_review_queue row produced from this one
 * upload gets tagged with the returned id, so either can always be traced
 * back to the literal source document later.
 */
async function handleSaveManifestUpload(req, res) {
  const { fileUrl, filename, contentType, uploadedBy } = req.body;
  if (!fileUrl) return res.status(400).json({ error: 'fileUrl is required' });

  const { data, error } = await supabase
    .from('manifest_uploads')
    .insert({
      file_url: fileUrl,
      filename: filename || null,
      content_type: contentType || null,
      uploaded_by: uploadedBy || null,
    })
    .select();
  if (error) throw error;
  res.status(200).json(data[0]);
}

module.exports = async (req, res) => {
  try {
    if (req.query.action === 'save-manifest-upload') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      return await handleSaveManifestUpload(req, res);
    }

    if (req.query.action === 'review-queue') {
      if (req.method === 'GET') return await handleReviewQueueGet(req, res);
      if (req.method === 'POST') return await handleReviewQueuePost(req, res);
      if (req.method === 'PATCH') return await handleReviewQueuePatch(req, res);
      return res.status(405).json({ error: 'GET, POST, or PATCH only' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (req.query.action === 'extract-manifest') {
      return await handleExtractManifest(req, res);
    }
    return await handleLogShipment(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
