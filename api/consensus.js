// ============================================================================
// GWTTKB Consensus Trigger
// Vercel cron fires this at 2am — triggers GitHub Action to do the real work
// GitHub Actions have no timeout limit — perfect for our 5-10 min pipeline
// ============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const isCron = req.headers['x-vercel-cron'] === '1';
  const isManual = req.query.secret === process.env.CRON_SECRET;

  // Status check
  if (!isCron && !isManual) {
    return res.status(200).json({
      message: 'GWTTKB Consensus Engine',
      status: 'ready',
      trigger: 'Add ?secret=YOUR_SECRET to trigger a rebuild',
      schedule: 'Runs daily at 2am ET via Vercel cron'
    });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    return res.status(500).json({ error: 'GitHub credentials not configured' });
  }

  // Fire GitHub Action via repository_dispatch event
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GWTTKB/1.0',
        Accept: 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        event_type: 'build-consensus',
        client_payload: {
          date: new Date().toISOString().split('T')[0],
          triggered_by: isCron ? 'cron' : 'manual'
        }
      })
    }
  );

  if (response.ok || response.status === 204) {
    return res.status(200).json({
      success: true,
      message: 'Consensus build triggered — GitHub Action is now running',
      monitor: `https://github.com/${owner}/${repo}/actions`
    });
  } else {
    const err = await response.text();
    return res.status(500).json({ error: 'Failed to trigger action', detail: err });
  }
}
