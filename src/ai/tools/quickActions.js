/**
 * Reusable structured quick-action payloads for the AI chat contract.
 * Backend emits data only — no UI components.
 */

/**
 * @param {string} question
 * @param {{ label: string, value: string }[]} options
 */
const buildQuickActions = (question, options) => ({
  type: 'quick_actions',
  question: String(question || '').trim(),
  options: (Array.isArray(options) ? options : [])
    .filter((o) => o && o.label && o.value)
    .map((o) => ({
      label: String(o.label),
      value: String(o.value),
    })),
});

const LISTING_TYPE_OPTIONS = [
  { label: 'Buy', value: 'buy' },
  { label: 'Rent', value: 'rent' },
  { label: 'Off-plan', value: 'off-plan' },
];

const BEDROOM_OPTIONS = [
  { label: 'Studio', value: 'studio' },
  { label: '1', value: '1' },
  { label: '2', value: '2' },
  { label: '3+', value: '3+' },
];

const PROPERTY_TYPE_OPTIONS = [
  { label: 'Apartment', value: 'Apartment' },
  { label: 'Villa', value: 'Villa' },
  { label: 'Townhouse', value: 'Townhouse' },
  { label: 'Commercial', value: 'Commercial' },
];

const YES_NO_OPTIONS = [
  { label: 'Yes', value: 'yes' },
  { label: 'No', value: 'no' },
];

const CATEGORY_OPTIONS = [
  { label: 'Residential', value: 'residential' },
  { label: 'Commercial', value: 'commercial' },
];

const listingTypeQuickActions = () =>
  buildQuickActions(
    'Are you looking to buy, rent, or explore off-plan properties?',
    LISTING_TYPE_OPTIONS
  );

const bedroomQuickActions = () =>
  buildQuickActions('How many bedrooms are you looking for?', BEDROOM_OPTIONS);

const sellPropertyTypeQuickActions = () =>
  buildQuickActions('What type of property are you looking to sell?', PROPERTY_TYPE_OPTIONS);

module.exports = {
  buildQuickActions,
  listingTypeQuickActions,
  bedroomQuickActions,
  sellPropertyTypeQuickActions,
  LISTING_TYPE_OPTIONS,
  BEDROOM_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  YES_NO_OPTIONS,
  CATEGORY_OPTIONS,
};
