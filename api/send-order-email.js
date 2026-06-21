const supabase = require('./_supabase');

/**
 * POST: sends a generated order PDF by email via Resend's HTTP API (no SDK
 * needed -- Vercel's Node runtime has global fetch). Requires RESEND_API_KEY
 * to be set as a Vercel environment variable, and RESEND_FROM_EMAIL to be an
 * address on a domain verified with Resend. Until those are set, this
 * endpoint fails clearly rather than silently -- same pattern as the Twilio
 * env vars needed elsewhere in the lab's stack.
 *
 * payload: { orderId, to, cc, subject, notes, pdfBase64, filename }
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
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

    res.status(200).json({ success: true, sentAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
