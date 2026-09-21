function parsePriceNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  const mil = s.match(/(\d+(?:\.\d+)?)\s*(m|mn|million)\b/i);
  if (mil) return Number(mil[1]) * 1_000_000;
  const k = s.match(/(\d+(?:\.\d+)?)\s*(k|thousand)\b/i);
  if (k) return Number(k[1]) * 1_000;
  const n = Number(s.replace(/,/g, '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function formatAed(value) {
  const n = typeof value === 'number' ? value : parsePriceNumber(value);
  if (!Number.isFinite(n) || n < 0) return '';
  const compact = (raw) => {
    const rounded = Math.round(raw * 100) / 100;
    return String(rounded.toFixed(2)).replace(/\.?0+$/, '');
  };
  if (n >= 1_000_000) return `AED ${compact(n / 1_000_000)}M`;
  if (n >= 1000) return `AED ${compact(n / 1000)}K`;
  return `AED ${Math.round(n)}`;
}

module.exports = { formatAed, parsePriceNumber };
