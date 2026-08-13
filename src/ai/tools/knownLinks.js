/**
 * Controlled known Rocky public URLs for AI structured actions.
 * The model must never invent URLs — use only these helpers.
 */

const SERVICE_LINKS = Object.freeze({
  services: {
    title: 'Our Services',
    url: '/services',
  },
  'property-management': {
    title: 'Property Management',
    url: '/services/property-management',
  },
  brokerage: {
    title: 'Brokerage',
    url: '/services/brokerage',
  },
});

const COMPANY_LINKS = Object.freeze({
  whoWeAre: '/who-we-are',
  ourTeam: '/our-team',
  testimonials: '/testimonials',
  achievements: '/achievements',
  careers: 'https://careers.rockyrealestate.com/',
  blogs: '/blogs',
  areaGuides: '/area-guides',
});

/**
 * Build a public property detail URL from listing type + reference.
 * @param {'buy'|'rent'|'off-plan'} listingType
 * @param {string} propertyRefNo
 * @returns {string|null}
 */
const buildPropertyPublicUrl = (listingType, propertyRefNo) => {
  const ref = String(propertyRefNo || '').trim();
  if (!ref) return null;

  const encoded = encodeURIComponent(ref);
  if (listingType === 'rent') {
    return `/properties/rent/in-dubai/${encoded}`;
  }
  if (listingType === 'off-plan') {
    return `/off-plan-properties/in-dubai/${encoded}`;
  }
  if (listingType === 'buy') {
    return `/properties/buy/in-dubai/${encoded}`;
  }
  return null;
};

/**
 * @param {string} key
 * @returns {{ title: string, url: string }|null}
 */
const getServiceLink = (key) => {
  const entry = SERVICE_LINKS[key];
  return entry ? { ...entry } : null;
};

module.exports = {
  SERVICE_LINKS,
  COMPANY_LINKS,
  buildPropertyPublicUrl,
  getServiceLink,
};
