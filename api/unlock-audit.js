export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false });
  }

  const expectedPassword = process.env.AUDIT_PASSWORD;
  const providedPassword = req.body && req.body.password;

  if (!expectedPassword) {
    return res.status(500).json({ success: false });
  }

  return res.status(200).json({
    success: providedPassword === expectedPassword
  });
}
