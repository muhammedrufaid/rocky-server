const HEAD_OFFICE_LISTING_AGENT = 'rocky head office';

/**
 * "yes" when the listing agent is Rocky Head Office, otherwise "no".
 * Comparison ignores surrounding spaces and letter case.
 * @param {unknown} listingAgent
 * @returns {'yes' | 'no'}
 */
const isHeadOfficeValue = (listingAgent) => {
  const name = listingAgent == null ? '' : String(listingAgent).trim().toLowerCase();
  return name === HEAD_OFFICE_LISTING_AGENT ? 'yes' : 'no';
};

module.exports = {
  HEAD_OFFICE_LISTING_AGENT,
  isHeadOfficeValue,
};
