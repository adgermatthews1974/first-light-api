export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { title, genre, pov, position, manuscript } = req.body;

  if (!manuscript || manuscript.trim().split(/\s+/).length < 100) {
    return res.status(400).json({ error: 'Manuscript too short' });
  }

  const systemPrompt = `You are First Light, a professional beta reader and manuscript assessment tool created by Soul Forged Studios. You read submitted manuscript chapters and provide honest, structured, constructive feedback exactly as a professional beta reader would.

Your assessment is always honest and direct without being cruel, specific with examples from the text, constructive with actionable suggestions, and calibrated to the genre and story position.

Return ONLY a JSON object with this exact structure, no preamble, no markdown:
{
  "pacing": { "rating": "Strong|Solid|Developing|Needs Work", "assessment": "detailed text" },
  "characterVoice": { "rating": "Strong|Solid|Developing|Needs Work", "assessment": "detailed text" },
  "emotionalResonance": { "rating": "Strong|Solid|Developing|Needs Work", "assessment": "detailed text" },
  "continuity": { "rating": "Strong|Solid|Developing|Needs Work", "assessment": "detailed text" },
  "dialogue": { "rating": "Strong|Solid|Developing|Needs Work", "assessment": "detailed text" },
  "worldBuilding": { "rating": "Strong|Solid|Developing|Needs Work", "assessment": "detailed text" },
  "overallScore": "X/10",
  "overallLabel": "Ready for Beta Readers|Needs Revision|Strong Foundation|Almost There",
  "overallAssessment": "2-3 sentence honest overall summary"
}`;

  const userPrompt = `Chapter: ${title || 'Untitled'}
Genre: ${genre}
Point of View: ${pov || 'Not specified'}
Position in story: ${position || 'Not specified'}

MANUSCRIPT:
${manuscript}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const data = await response.json();
    const raw = data.content.map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: 'Assessment failed. Please try again.' });
  }
}
