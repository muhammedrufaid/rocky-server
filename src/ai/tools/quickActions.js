/**
 * Reusable structured quick-action payloads for conversion-first Rocky AI.
 * Backend emits data only — no UI components. Prefer 3–5 options.
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
    .slice(0, 5)
    .map((o) => ({
      label: String(o.label),
      value: String(o.value),
    })),
});

const GREETING_OPTIONS = [
  { label: 'Buy a Property', value: 'Buy a Property' },
  { label: 'Rent a Property', value: 'Rent a Property' },
  { label: 'Off-Plan Properties', value: 'Off-Plan Properties' },
  { label: 'Sell My Property', value: 'Sell My Property' },
  { label: 'Property Management', value: 'Property Management' },
];

const LISTING_TYPE_OPTIONS = [
  { label: 'Buy', value: 'buy' },
  { label: 'Rent', value: 'rent' },
  { label: 'Off-plan', value: 'off-plan' },
];

const BUY_PROPERTY_TYPE_OPTIONS = [
  { label: 'Apartment', value: 'Apartment' },
  { label: 'Villa', value: 'Villa' },
  { label: 'Townhouse', value: 'Townhouse' },
  { label: 'Penthouse', value: 'Penthouse' },
  { label: 'Commercial', value: 'Commercial' },
];

const LOCATION_OPTIONS = [
  { label: 'Dubai Marina', value: 'Dubai Marina' },
  { label: 'Downtown Dubai', value: 'Downtown Dubai' },
  { label: 'Business Bay', value: 'Business Bay' },
  { label: 'Dubai South', value: 'Dubai South' },
  { label: 'Other Area', value: 'Other Area' },
];

const BEDROOM_OPTIONS = [
  { label: 'Studio', value: 'studio' },
  { label: '1 Bedroom', value: '1' },
  { label: '2 Bedrooms', value: '2' },
  { label: '3+ Bedrooms', value: '3+' },
];

const PROPERTY_TYPE_OPTIONS = [
  { label: 'Apartment', value: 'Apartment' },
  { label: 'Villa', value: 'Villa' },
  { label: 'Townhouse', value: 'Townhouse' },
  { label: 'Commercial', value: 'Commercial' },
];

const AFTER_RESULTS_OPTIONS = [
  { label: 'View More Properties', value: 'View More Properties' },
  { label: 'Change Search', value: 'Change Search' },
  { label: 'Talk to an Agent', value: 'Talk to an Agent' },
];

const AFTER_RESULTS_HIGH_OPTIONS = [
  { label: 'Talk to an Agent', value: 'Talk to an Agent' },
  { label: 'WhatsApp Rocky', value: 'WhatsApp Rocky' },
  { label: 'Schedule a Viewing', value: 'Schedule a Viewing' },
  { label: 'View More Properties', value: 'View More Properties' },
];

const HIGH_INTENT_OPTIONS = [
  { label: 'Schedule a Viewing', value: 'Schedule a Viewing' },
  { label: 'Talk to an Agent', value: 'Talk to an Agent' },
  { label: 'WhatsApp Rocky', value: 'WhatsApp Rocky' },
];

const SERVICE_MENU_OPTIONS = [
  { label: 'Property Management', value: 'Property Management' },
  { label: 'Brokerage', value: 'Brokerage' },
  { label: 'Property Listing & Marketing', value: 'Property Listing & Marketing' },
];

const SERVICE_PM_OPTIONS = [
  { label: 'Contact Property Management', value: 'Contact Property Management' },
  { label: 'WhatsApp Rocky', value: 'WhatsApp Rocky' },
];

const SELL_DONE_OPTIONS = [
  { label: 'Contact Rocky', value: 'Contact Rocky' },
  { label: 'WhatsApp Rocky', value: 'WhatsApp Rocky' },
];

const KNOWLEDGE_AREA_OPTIONS = [
  { label: 'Explore Dubai Areas', value: 'Explore Dubai Areas' },
  { label: 'View Properties', value: 'View Properties' },
  { label: 'Talk to an Agent', value: 'Talk to an Agent' },
];

const KNOWLEDGE_GENERAL_OPTIONS = [
  { label: 'View Properties', value: 'View Properties' },
  { label: 'Talk to an Agent', value: 'Talk to an Agent' },
  { label: 'WhatsApp Rocky', value: 'WhatsApp Rocky' },
];

const YES_NO_OPTIONS = [
  { label: 'Yes', value: 'yes' },
  { label: 'No', value: 'no' },
];

const greetingQuickActions = () =>
  buildQuickActions('How can I help you today?', GREETING_OPTIONS);

const listingTypeQuickActions = () =>
  buildQuickActions(
    'Are you looking to buy, rent, or explore off-plan properties?',
    LISTING_TYPE_OPTIONS
  );

const propertyTypeQuickActions = () =>
  buildQuickActions('What type of property are you looking for?', BUY_PROPERTY_TYPE_OPTIONS);

const locationQuickActions = () =>
  buildQuickActions('Which area are you interested in?', LOCATION_OPTIONS);

const bedroomQuickActions = () =>
  buildQuickActions('How many bedrooms are you looking for?', BEDROOM_OPTIONS);

const sellPropertyTypeQuickActions = () =>
  buildQuickActions('What type of property are you looking to sell?', PROPERTY_TYPE_OPTIONS);

const afterResultsQuickActions = (highIntent = false) =>
  buildQuickActions(
    highIntent
      ? 'Found something you like? I can help you take the next step.'
      : 'Would you like to see more properties or speak with an agent?',
    highIntent ? AFTER_RESULTS_HIGH_OPTIONS : AFTER_RESULTS_OPTIONS
  );

const highIntentQuickActions = () =>
  buildQuickActions(
    'I can help you take the next step.',
    HIGH_INTENT_OPTIONS
  );

const serviceMenuQuickActions = () =>
  buildQuickActions('Which service would you like to explore?', SERVICE_MENU_OPTIONS);

const servicePmQuickActions = () =>
  buildQuickActions(
    'Would you like to speak with our property management team?',
    SERVICE_PM_OPTIONS
  );

const sellDoneQuickActions = () =>
  buildQuickActions('Would you like our team to contact you?', SELL_DONE_OPTIONS);

const knowledgeAreaQuickActions = () =>
  buildQuickActions('What would you like to do next?', KNOWLEDGE_AREA_OPTIONS);

const knowledgeGeneralQuickActions = () =>
  buildQuickActions('What would you like to do next?', KNOWLEDGE_GENERAL_OPTIONS);

module.exports = {
  buildQuickActions,
  greetingQuickActions,
  listingTypeQuickActions,
  propertyTypeQuickActions,
  locationQuickActions,
  bedroomQuickActions,
  sellPropertyTypeQuickActions,
  afterResultsQuickActions,
  highIntentQuickActions,
  serviceMenuQuickActions,
  servicePmQuickActions,
  sellDoneQuickActions,
  knowledgeAreaQuickActions,
  knowledgeGeneralQuickActions,
  LISTING_TYPE_OPTIONS,
  BEDROOM_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  BUY_PROPERTY_TYPE_OPTIONS,
  LOCATION_OPTIONS,
  YES_NO_OPTIONS,
  GREETING_OPTIONS,
};
