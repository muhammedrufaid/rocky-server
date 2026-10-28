const { ApplyError, redactForLog } = require('./teamtailorApplyValidation');

const SUBJECT = 'Rocky Real Estate Relocation Guide';
const DEFAULT_FROM_EMAIL = 'relocation@rockyrealestate.com';
const DEFAULT_FROM_NAME = 'Rocky Real Estate';
const DEFAULT_RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_LOGO_URL = 'https://placehold.co/240x80/1B2A3B/FFFFFF.png?text=ROCKY+REAL+ESTATE';
const DEFAULT_BROCHURE_URL = 'https://rockyrealestate-website.s3.eu-north-1.amazonaws.com/images/general/company-profile-mockup.webp';
const WEBSITE_URL = 'https://www.rockyrealestate.com';
const WEBSITE_LABEL = 'rockyrealestate.com';
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
    'Rocky Real Estate Relocation Guide',
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
    "You're receiving this email because you requested the Rocky Real Estate Relocation Guide.",
    '',
    'Al Khaimah 2, Al Barsha 1, Dubai, United Arab Emirates',
    '',
    '© 2026 Rocky Real Estate. All rights reserved.',
  ].join('\n');

  const html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Your Dubai Relocation Guide</title>
  </head>
  <body style="margin:0;padding:0;background:#EFEAE2;">
    <!-- Preheader (inbox preview text) -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#EFEAE2;font-size:1px;line-height:1px;">
      Your Rocky Real Estate Relocation Guide is ready to download.
    </div>
   
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#EFEAE2;">
      <tr>
        <td align="center" style="padding:40px 16px;">
   
          <!-- Card -->
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#FFFFFF;">
   
            <!-- Header: logo + website -->
            <tr>
              <td style="padding:32px 48px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td align="left" valign="middle" style="line-height:0;">
                      ${logo}
                    </td>
                    <td align="right" valign="middle" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1;letter-spacing:1.5px;text-transform:uppercase;">
                      <a href="${WEBSITE_URL}" style="color:#0D365E;text-decoration:none;">${WEBSITE_LABEL}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
   
            <!-- Hairline -->
            <tr>
              <td style="background:#E7DCCD;height:1px;font-size:0;line-height:0;">&nbsp;</td>
            </tr>
   
            <!-- Hero image (full bleed) -->
            ${brochure}
   
            <!-- Content -->
            <tr>
              <td align="center" style="padding:52px 48px 8px;font-family:Arial,Helvetica,sans-serif;color:#333333;">
                <p style="margin:0 0 18px;font-size:11px;line-height:1;letter-spacing:3px;text-transform:uppercase;color:#B09877;font-weight:bold;">Relocation Guide</p>
                <h1 style="margin:0 0 24px;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.2;font-weight:normal;color:#0D365E;">Your guide to<br>moving to Dubai</h1>
                <!-- Short sand rule -->
                <table role="presentation" align="center" cellspacing="0" cellpadding="0" style="margin:0 auto 28px;">
                  <tr><td width="48" height="2" style="width:48px;height:2px;background:#C3AD95;font-size:0;line-height:0;">&nbsp;</td></tr>
                </table>
                <p style="margin:0 0 14px;font-size:16px;line-height:1.7;color:#333333;">Hi ${safeName},</p>
                <p style="margin:0 0 36px;font-size:16px;line-height:1.7;color:#5A5A5A;">Thank you for your interest in the Rocky Real Estate Relocation Guide. Your copy is ready to download. We hope it helps as you plan your move.</p>
              </td>
            </tr>
   
            <!-- Button -->
            <tr>
              <td align="center" style="padding:0 48px 18px;">
                <table role="presentation" align="center" cellspacing="0" cellpadding="0">
                  <tr>
                    <td bgcolor="#0D365E" style="background:#0D365E;">
                      <a href="${safeUrl}" style="display:inline-block;padding:18px 40px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;line-height:1;letter-spacing:2px;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">Download the guide</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
   
            <!-- Website link -->
            <tr>
              <td align="center" style="padding:0 48px 56px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#8A8A8A;">
                or visit <a href="${WEBSITE_URL}" style="color:#0D365E;text-decoration:underline;">${WEBSITE_LABEL}</a>
              </td>
            </tr>
   
            <!-- Footer (navy) -->
            <tr>
              <td align="center" bgcolor="#0D365E" style="background:#0D365E;padding:40px 48px 36px;font-family:Arial,Helvetica,sans-serif;">
   
                <!-- Social icons -->
                <table role="presentation" align="center" cellspacing="0" cellpadding="0" style="margin:0 auto 28px;">
                  <tr>
                    <td style="padding:0 6px;">
                      <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                        <td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;border:1px solid #4C7099;border-radius:20px;">
                          <a href="https://www.facebook.com/rockyrealestatedubai/" style="text-decoration:none;"><img src="https://img.icons8.com/ios-filled/48/FFFFFF/facebook-new.png" alt="Facebook" width="18" height="18" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;"></a>
                        </td>
                      </tr></table>
                    </td>
                    <td style="padding:0 6px;">
                      <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                        <td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;border:1px solid #4C7099;border-radius:20px;">
                          <a href="https://www.instagram.com/rockyrealestatedubai" style="text-decoration:none;"><img src="https://img.icons8.com/ios-filled/48/FFFFFF/instagram-new.png" alt="Instagram" width="18" height="18" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;"></a>
                        </td>
                      </tr></table>
                    </td>
                    <td style="padding:0 6px;">
                      <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                        <td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;border:1px solid #4C7099;border-radius:20px;">
                          <a href="https://www.linkedin.com/company/rockyrealestatedubai/" style="text-decoration:none;"><img src="https://img.icons8.com/ios-filled/48/FFFFFF/linkedin.png" alt="LinkedIn" width="18" height="18" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;"></a>
                        </td>
                      </tr></table>
                    </td>
                    <td style="padding:0 6px;">
                      <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                        <td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;border:1px solid #4C7099;border-radius:20px;">
                          <a href="https://www.tiktok.com/@rockyrealestatedubai" style="text-decoration:none;"><img src="https://img.icons8.com/ios-filled/48/FFFFFF/tiktok.png" alt="TikTok" width="18" height="18" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;"></a>
                        </td>
                      </tr></table>
                    </td>
                  </tr>
                </table>
   
                <!-- Website -->
                <p style="margin:0 0 20px;font-size:12px;line-height:1;letter-spacing:2px;text-transform:uppercase;">
                  <a href="${WEBSITE_URL}" style="color:#C3AD95;text-decoration:none;">${WEBSITE_LABEL}</a>
                </p>
   
                <p style="margin:0 0 6px;font-size:12px;line-height:1.7;color:#B9C6D6;">You're receiving this email because you requested the Rocky Real Estate Relocation Guide.</p>
                <p style="margin:0 0 24px;font-size:12px;line-height:1.7;color:#B9C6D6;">Al Khaimah 2, Al Barsha 1, Dubai, United Arab Emirates</p>
                <p style="margin:0;font-size:11px;line-height:1.5;color:#7F97B3;">© 2026 Rocky Real Estate. All rights reserved.</p>
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
