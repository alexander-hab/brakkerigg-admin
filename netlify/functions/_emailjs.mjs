const EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send"

export async function sendEmailjsEmail({ to, subject, text, html, templateId }) {
  const serviceId = process.env.EMAILJS_SERVICE_ID
  const publicKey = process.env.EMAILJS_PUBLIC_KEY
  const privateKey = process.env.EMAILJS_PRIVATE_KEY

  if (!serviceId || !publicKey || !privateKey || !templateId || !to) {
    return { skipped: true, reason: "missing_config_or_recipient" }
  }

  const res = await fetch(EMAILJS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${privateKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: {
        to_email: to,
        subject,
        message_text: text,
        message_html: html
      }
    })
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`EmailJS error ${res.status}: ${errText}`)
  }

  return res.text()
}