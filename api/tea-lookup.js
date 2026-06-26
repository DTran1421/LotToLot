const supabase = require('./_supabase');

/**
 * Looks up a TEa entry by name: exact analyte_name match, then alias match,
 * then a loose "contains" match -- same fallback order the old hardcoded
 * lookupTea() used, just backed by a real table now.
 */
async function handleTeaLookup(req, res) {
  const name = (req.query.analyte || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'analyte query param is required' });

  const { data: all, error } = await supabase.from('tea_criteria').select('*');
  if (error) throw error;

  let match = all.find((r) => r.analyte_name.toLowerCase() === name);
  if (!match) match = all.find((r) => (r.aliases || []).some((a) => a.toLowerCase() === name));
  if (!match) {
    match = all.find((r) => {
      const an = r.analyte_name.toLowerCase();
      if (an.includes(name) || name.includes(an)) return true;
      return (r.aliases || []).some((a) => a.toLowerCase().includes(name) || name.includes(a.toLowerCase()));
    });
  }

  if (!match) return res.status(404).json({ error: 'No TEa match found.' });
  res.status(200).json(match);
}

/**
 * Server-side proxy for the Lot Comparison page's "Upload printout (AI
 * extract)" feature. The Anthropic API key lives ONLY here as a private
 * Vercel env var (ANTHROPIC_API_KEY) -- it must never be sent to the
 * browser or hardcoded into compare.html, unlike the Supabase anon key
 * used elsewhere in this app. Supabase's anon key is designed to be public
 * (Row Level Security is the actual protection layer); an Anthropic key
 * is tied directly to account billing, so exposing it client-side would
 * let anyone who views page source run up charges on the account.
 *
 * The browser sends just the file (base64 + media type); the extraction
 * prompt itself stays server-side too, rather than trusting whatever a
 * client might send as "instructions".
 */
async function handleExtract(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set. Add it in the Vercel project\u2019s environment variables (get a key from console.anthropic.com) before AI extraction will work. You can still use "Paste / type data" in the meantime.',
    });
  }

  const { base64, mediaType, isPdf } = req.body;
  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'base64 and mediaType are required' });
  }

  const instructions = `This is a clinical lab instrument printout used for a lot-to-lot reagent or calibrator verification study. The printout may contain ONE analyte with a clean table of paired results, OR it may contain MULTIPLE analytes mixed together with many other data points (e.g. a DxI-style results dump).

Extract EVERY individual numeric result you can find that looks like a sample result tied to an analyte, a sample/specimen identifier, and a lot or run identifier/column header. Do not try to guess which lot is "old" vs "new" -- just report the column header / lot label exactly as printed.

Return ONLY raw JSON (no markdown fences, no commentary) in this exact shape:
{"records":[{"analyte":"<analyte name as printed>","sampleId":"<sample/specimen id as printed>","label":"<column header or lot/run identifier as printed>","value":<numeric value>}]}

If a sample only has one value with no clear pairing column, still include it with whatever label is available. If you genuinely cannot find any tabular numeric data, return {"records":[]}.`;

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
      max_tokens: 1000,
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
  try {
    if (req.method === 'POST') {
      return await handleExtract(req, res);
    }
    return await handleTeaLookup(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
