export async function sendResendEmail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM

  if (!apiKey || !from || !to) {
    return { skipped: true, reason: "missing_config_or_recipient" }
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
      html
    })
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Resend error ${res.status}: ${errText}`)
  }

  return res.json()
}