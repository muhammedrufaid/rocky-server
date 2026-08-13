/**
 * Official Rocky WhatsApp CTA helper.
 * Reuses the public company WhatsApp from the website sticky widget.
 * Never invents private agent numbers.
 *
 * Override with ROCKY_WHATSAPP_NUMBER (digits only, country code included).
 */

const DEFAULT_ROCKY_WHATSAPP = '971542003156';
const DEFAULT_PREFILL =
  "Hi, I'm interested in Rocky Real Estate and would like further information from you.";

/**
 * @returns {string|null} digits-only WhatsApp number
 */
const getRockyWhatsAppNumber = () => {
  const fromEnv =
    typeof process.env.ROCKY_WHATSAPP_NUMBER === 'string'
      ? process.env.ROCKY_WHATSAPP_NUMBER.replace(/\D/g, '')
      : '';
  if (fromEnv && fromEnv.length >= 10) return fromEnv;
  return DEFAULT_ROCKY_WHATSAPP;
};

/**
 * @param {string} [prefill]
 * @returns {{ type: string, label: string, url: string, service: string }|null}
 */
const buildWhatsAppAction = (prefill = DEFAULT_PREFILL) => {
  const number = getRockyWhatsAppNumber();
  if (!number) return null;

  const text = String(prefill || DEFAULT_PREFILL).trim().slice(0, 500);
  const url = `https://wa.me/${number}?text=${encodeURIComponent(text)}`;

  return {
    type: 'whatsapp_action',
    label: 'WhatsApp Rocky',
    url,
    service: 'whatsapp',
  };
};

module.exports = {
  getRockyWhatsAppNumber,
  buildWhatsAppAction,
  DEFAULT_ROCKY_WHATSAPP,
  DEFAULT_PREFILL,
};
