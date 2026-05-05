// Email capture endpoint
// Saves email signups to data/beta-signups.json in the GitHub repo
// You can pull this list to import into ConvertKit / Mailchimp / Beehiiv later

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, source } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const githubToken = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER || 'GWTTKB';
    const repo = process.env.GITHUB_REPO || 'GWTTKB';
    const path = 'data/beta-signups.json';

    if (!githubToken) {
      // No GitHub configured — just acknowledge so user gets bonus questions
      console.warn('GITHUB_TOKEN not set — email captured locally only');
      return res.status(200).json({ ok: true, stored: 'local-only' });
    }

    // 1. Get current file (if exists) to read sha + decode content
    const ghHeaders = {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    let existing = { signups: [] };
    let sha = null;

    try {
      const getRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        { headers: ghHeaders }
      );
      if (getRes.ok) {
        const data = await getRes.json();
        sha = data.sha;
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        existing = JSON.parse(content);
        if (!Array.isArray(existing.signups)) existing.signups = [];
      }
    } catch (e) {
      // File doesn't exist yet — we'll create it
    }

    // Check if email already exists
    const normalizedEmail = email.toLowerCase().trim();
    const alreadySignedUp = existing.signups.some(s => 
      (s.email || '').toLowerCase().trim() === normalizedEmail
    );

    if (alreadySignedUp) {
      // Idempotent: still return ok so the user gets bonus questions
      return res.status(200).json({ ok: true, stored: 'already-exists' });
    }

    // Add new signup
    existing.signups.push({
      email: normalizedEmail,
      source: source || 'beta-modal',
      timestamp: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown'
    });

    existing.last_updated = new Date().toISOString();
    existing.total_signups = existing.signups.length;

    // 2. Commit updated file
    const newContent = Buffer.from(JSON.stringify(existing, null, 2)).toString('base64');
    const putRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `chore: beta signup (${normalizedEmail.slice(0, 3)}...)`,
          content: newContent,
          ...(sha ? { sha } : {})
        })
      }
    );

    if (!putRes.ok) {
      const errText = await putRes.text();
      console.error('GitHub PUT failed:', putRes.status, errText);
      // Still return ok so user gets bonus questions — we'll lose the email but not the UX
      return res.status(200).json({ ok: true, stored: 'github-failed' });
    }

    return res.status(200).json({ ok: true, stored: 'github', total: existing.total_signups });
  } catch (e) {
    console.error('Email signup error:', e);
    // Always return ok so user gets bonus questions — never block UX on backend issues
    return res.status(200).json({ ok: true, stored: 'error', error: e.message });
  }
}
