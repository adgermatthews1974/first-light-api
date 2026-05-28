// /api/soulforged.js
// Vercel serverless function — thin proxy to Anthropic's Messages API for the SOULFORGED demo.
// Replaces the previous version. Uses a current model name and surfaces real API errors.

export default async function handler(req, res) {
  // CORS — allow the demo to be called from any origin (Squarespace embed, iframes, direct page loads)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Parse request body
  const body = req.body || {};
  const { system, messages, max_tokens } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required and must not be empty' });
  }

  // Check API key is configured
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[soulforged] ANTHROPIC_API_KEY environment variable not set');
    return res.status(500).json({ error: 'Server configuration error: API key not set' });
  }

  try {
    // Call Anthropic Messages API directly (no SDK dependency)
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: max_tokens || 1000,
        system: system || '',
        messages: messages
      })
    });

    const data = await anthropicResponse.json();

    // If Anthropic returned an error, log it server-side AND pass the real error message to the frontend
    if (!anthropicResponse.ok) {
      console.error('[soulforged] Anthropic API returned', anthropicResponse.status, JSON.stringify(data));
      return res.status(anthropicResponse.status).json({
        error: (data && data.error && data.error.message) ? data.error.message : 'Anthropic API error',
        type: data && data.error && data.error.type ? data.error.type : 'unknown',
        status: anthropicResponse.status,
        raw: data
      });
    }

    // Success — return the Anthropic response as-is so the frontend can read data.content[0].text
    return res.status(200).json(data);

  } catch (err) {
    console.error('[soulforged] Function exception:', err.name, err.message, err.stack);
    return res.status(500).json({
      error: err.message || 'Unknown function error',
      name: err.name
    });
  }
}
