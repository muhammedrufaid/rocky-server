const { ApplyError, redactForLog } = require('./teamtailorApplyValidation');

const SUBJECT = 'Your Free Dubai Relocation Guide | Rocky Real Estate';
const DEFAULT_FROM_EMAIL = 'relocation@rockyrealestate.com';
const DEFAULT_FROM_NAME = 'Rocky Real Estate';
const DEFAULT_RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_LOGO_URL = 'https://placehold.co/240x80/1B2A3B/FFFFFF.png?text=ROCKY+REAL+ESTATE';
const DEFAULT_BROCHURE_URL = 'https://rockyrealestate-website.s3.eu-north-1.amazonaws.com/images/general/company-profile-mockup.webp';
const REQUEST_TIMEOUT_MS = 20000;

function getEmailConfig() {
  return {
    apiKey: String(process.env.RESEND_API_KEY || '').trim(),
    fromEmail: String(process.env.RESEND_FROM_EMAIL || DEFAULT_FROM_EMAIL).trim(),
    fromName: String(process.env.RESEND_FROM_NAME || DEFAULT_FROM_NAME).trim(),
    guideUrl: String(process.env.RELOCATION_GUIDE_URL || '').trim(),
    logoUrl: String(process.env.RELOCATION_EMAIL_LOGO_URL || '').trim(),
    brochureUrl: String(process.env.RELOCATION_EMAIL_BROCHURE_URL || '').trim(),
    apiUrl: DEFAULT_RESEND_URL,
  };
}

function assertGuideUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ApplyError("We couldn't send your relocation guide. Please try again later.", {
      status: 503,
      code: 'guide_url_missing',
      logDetail: 'RELOCATION_GUIDE_URL is not a valid URL',
    });
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new ApplyError("We couldn't send your relocation guide. Please try again later.", {
      status: 503,
      code: 'guide_url_missing',
      logDetail: 'RELOCATION_GUIDE_URL must be an https URL without credentials',
    });
  }

  return parsed.toString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function publicHttpsUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    return candidate;
  } catch (error) {
    return '';
  }
}

function resolvePublicImageUrl(value, fallback) {
  const provided = String(value ?? '').trim();
  if (!provided) return publicHttpsUrl(fallback);
  return publicHttpsUrl(provided);
}

function formatFrom(name, email) {
  const safeName = String(name || DEFAULT_FROM_NAME).replace(/[<>"]/g, '').trim() || DEFAULT_FROM_NAME;
  return `${safeName} <${email}>`;
}

function buildRelocationGuideEmail({ firstName, guideUrl, logoUrl, brochureUrl }) {
  const safeName = escapeHtml(firstName);
  const safeUrl = escapeHtml(guideUrl);
  const safeLogoUrl = escapeHtml(resolvePublicImageUrl(logoUrl, DEFAULT_LOGO_URL));
  const safeBrochureUrl = escapeHtml(resolvePublicImageUrl(brochureUrl, DEFAULT_BROCHURE_URL));
  const logo = safeLogoUrl
    ? `<img src="${safeLogoUrl}" alt="Rocky Real Estate" width="240" height="50" style="display:block;width:240px;max-width:100%;height:auto;margin:0;border:0;outline:none;text-decoration:none;">`
    : '';
  const brochure = safeBrochureUrl
    ? `<tr>
            <td align="center" style="padding:0;font-size:0;line-height:0;">
              <!--[if !mso]><!-->
              <img src="${safeBrochureUrl}" alt="Dubai relocation guide" width="600" height="260" style="display:block;width:100%;max-width:600px;height:260px;object-fit:cover;object-position:center;border:0;outline:none;text-decoration:none;">
              <!--<![endif]-->
              <!--[if mso]>
              <img src="${safeBrochureUrl}" alt="Dubai relocation guide" width="600" style="display:block;width:600px;height:auto;border:0;outline:none;text-decoration:none;">
              <![endif]-->
            </td>
          </tr>`
    : '';
  const text = [
    'Rocky Real Estate',
    '',
    'Your Free Rocky Real Estate Relocation Guide',
    '',
    `Dear ${firstName},`,
    '',
    'Thank you for your interest in the Rocky Real Estate Relocation Guide.',
    '',
    'Your guide is ready to download. We hope you find it helpful as you plan your move to Dubai.',
    '',
    'Download your relocation guide:',
    guideUrl,
    '',
    'Facebook: https://www.facebook.com/rockyrealestatedubai/',
    'Instagram: https://www.instagram.com/rockyrealestatedubai',
    'LinkedIn: https://www.linkedin.com/company/rockyrealestatedubai/',
    'TikTok: https://www.tiktok.com/@rockyrealestatedubai',
    '',
    "You're receiving this email because you requested the Rocky relocation guide.",
    '',
    'Copyright © 2026. Rocky Real Estate | Al Khaimah 2, Al Barsha 1, Dubai, United Arab Emirates',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your Free Rocky Real Estate Relocation Guide</title>
</head>
<body style="margin:0;padding:0;background:#F6F6F6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F6F6F6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #E7DCCD;">
          <tr>
            <td align="left" style="background:#FFFFFF;padding:24px 32px 20px;font-family:Arial,sans-serif;line-height:0;">
              ${logo}
            </td>
          </tr>
          <tr>
            <td style="background:#C3AD95;height:3px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          ${brochure}
          <tr>
            <td style="padding:32px;font-family:Arial,sans-serif;color:#333333;">
              <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#0D365E;">Your Free Rocky Real Estate Relocation Guide</h1>
              <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Dear ${safeName},</p>
              <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Thank you for your interest in the Rocky Real Estate Relocation Guide.</p>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">Your guide is ready to download. We hope you find it helpful as you plan your move to Dubai.</p>
              <a href="${safeUrl}" style="display:inline-block;background:#0D365E;color:#FFFFFF;text-decoration:none;padding:14px 28px;font-size:16px;">Download Relocation Guide</a>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;background:#F6F6F6;border-top:1px solid #E7DCCD;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#333333;">
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 18px;">
                <tr>
                  <td style="padding:0 18px 0 0;">
                    <a href="https://www.facebook.com/rockyrealestatedubai/" style="text-decoration:none;">
                      <img src="https://img.icons8.com/ios-filled/48/333333/facebook-new.png" alt="Facebook" width="22" height="22" style="display:block;border:0;outline:none;text-decoration:none;">
                    </a>
                  </td>
                  <td style="padding:0 18px 0 0;">
                    <a href="https://www.instagram.com/rockyrealestatedubai" style="text-decoration:none;">
                      <img src="https://img.icons8.com/ios-filled/48/333333/instagram-new.png" alt="Instagram" width="22" height="22" style="display:block;border:0;outline:none;text-decoration:none;">
                    </a>
                  </td>
                  <td style="padding:0 18px 0 0;">
                    <a href="https://www.linkedin.com/company/rockyrealestatedubai/" style="text-decoration:none;">
                      <img src="https://img.icons8.com/ios-filled/48/333333/linkedin.png" alt="LinkedIn" width="22" height="22" style="display:block;border:0;outline:none;text-decoration:none;">
                    </a>
                  </td>
                  <td>
                    <a href="https://www.tiktok.com/@rockyrealestatedubai" style="text-decoration:none;">
                      <img src="https://img.icons8.com/ios-filled/48/333333/tiktok.png" alt="TikTok" width="22" height="22" style="display:block;border:0;outline:none;text-decoration:none;">
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 14px;font-size:12px;line-height:1.5;color:#333333;">You're receiving this email because you requested the Rocky relocation guide.</p>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#333333;">Copyright © 2026. Rocky Real Estate | Al Khaimah 2, Al Barsha 1, Dubai, United Arab Emirates</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject: SUBJECT, html, text };
}

async function sendRelocationGuideEmail({ to, firstName, idempotencyKey }, deps = {}) {
  const config = deps.config || getEmailConfig();
  const fetchImpl = deps.fetch || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (!config.apiKey) {
    throw new ApplyError("We couldn't send your relocation guide. Please try again later.", {
      status: 503,
      code: 'resend_auth',
      logDetail: 'Resend API key is not configured',
    });
  }
  if (!config.fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(config.fromEmail)) {
    throw new ApplyError("We couldn't send your relocation guide. Please try again later.", {
      status: 503,
      code: 'resend_from_invalid',
      logDetail: 'Resend from address is not configured',
    });
  }

  const guideUrl = assertGuideUrl(config.guideUrl);
  const content = buildRelocationGuideEmail({
    firstName,
    guideUrl,
    logoUrl: config.logoUrl,
    brochureUrl: config.brochureUrl,
  });
  const body = {
    from: formatFrom(config.fromName, config.fromEmail),
    to: [to],
    subject: content.subject,
    html: content.html,
    text: content.text,
  };

  const send = async () => {
    const timeout = deps.timeoutMs || REQUEST_TIMEOUT_MS;
    const response = await fetchImpl(config.apiUrl || DEFAULT_RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': String(idempotencyKey),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        payload = null;
      }
    }
    return { response, payload };
  };

  let result;
  try {
    result = await send();
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new ApplyError("We couldn't send your relocation guide. Please try again.", {
      status: 504,
      code: timedOut ? 'resend_timeout' : 'resend_network',
      retryable: true,
      logDetail: redactForLog(error.message, config.apiKey),
    });
  }

  if (result.response.status === 429 && !deps.retried) {
    await sleep(1000);
    return sendRelocationGuideEmail({ to, firstName, idempotencyKey }, { ...deps, retried: true });
  }

  if (result.response.status === 429) {
    throw new ApplyError("We couldn't send your relocation guide. Please try again.", {
      status: 503,
      code: 'resend_rate_limit',
      retryable: true,
      logDetail: 'Resend returned 429',
    });
  }

  if (result.response.status === 401 || result.response.status === 403) {
    throw new ApplyError("We couldn't send your relocation guide. Please try again later.", {
      status: 503,
      code: 'resend_auth',
      logDetail: `Resend returned ${result.response.status}`,
    });
  }

  if (!result.response.ok) {
    throw new ApplyError("We couldn't send your relocation guide. Please try again.", {
      status: 502,
      code: 'resend_rejected',
      retryable: result.response.status >= 500,
      logDetail: redactForLog(result.payload?.message || `Resend returned ${result.response.status}`, config.apiKey),
    });
  }

  const id = result.payload?.id;
  if (!id) {
    throw new ApplyError("We couldn't send your relocation guide. Please try again.", {
      status: 502,
      code: 'email_unconfirmed',
      retryable: true,
      logDetail: 'Resend accepted the request without an email id',
    });
  }

  return { id: String(id), guideUrl };
}

module.exports = {
  SUBJECT,
  getEmailConfig,
  buildRelocationGuideEmail,
  sendRelocationGuideEmail,
};
