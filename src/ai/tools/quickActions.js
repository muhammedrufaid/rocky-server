/**
 * Reusable structured quick-action payloads for conversion-first Rocky AI.
 * Backend emits data only — no UI components. Prefer 3–5 options.
 */

/**
 * @param {string} question
 * @param {{ label: string, value: string }[]} options
 * @param {{ multiSelect?: boolean }} [meta]
 */
const buildQuickActions = (question, options, meta = {}) => {
  const payload = {
    type: 'quick_actions',
    question: String(question || '').trim(),
    options: (Array.isArray(options) ? options : [])
      .filter((o) => o && o.label && o.value)
      .slice(0, 6)
      .map((o) => ({
        label: String(o.label),
        value: String(o.value),
      })),
  };
  if (meta.multiSelect) {
    payload.multiSelect = true;
  }
  return payload;
};

const GREETING_OPTIONS = [
  { label: 'Buy a Property', value: 'Buy a Property' },
  { label: 'Rent a Property', value: 'Rent a Property' },
  { label: 'Off-Plan', value: 'Off-Plan' },
  { label: 'Sell My Property', value: 'Sell My Property' },
  { label: 'Property Management', value: 'Property Management' },
];

const LISTING_TYPE_OPTIONS = [
  { label: 'Buy', value: 'buy' },
  { label: 'Rent', value: 'rent' },
  { label: 'Off-plan', value: 'off-plan' },
];

const PROPERTY_TYPE_OPTIONS_CORE = [
  { label: 'Apartment', value: 'Apartment' },
  { label: 'Villa', value: 'Villa' },
  { label: 'Townhouse', value: 'Townhouse' },
  { label: 'Penthouse', value: 'Penthouse' },
];

const PROPERTY_TYPE_OPTIONS_WITH_COMMERCIAL = [
  ...PROPERTY_TYPE_OPTIONS_CORE,
  { label: 'Commercial', value: 'Commercial' },
];

const LOCATION_OPTIONS = [
  { label: 'Dubai Marina', value: 'Dubai Marina' },
  { label: 'Downtown Dubai', value: 'Downtown Dubai' },
  { label: 'Business Bay', value: 'Business Bay' },
  { label: 'Dubai South', value: 'Dubai South' },
  { label: 'Jumeirah', value: 'Jumeirah' },
  { label: 'Other Area', value: 'Other Area' },
];

const BEDROOM_OPTIONS = [
  { label: 'Studio', value: 'studio' },
  { label: '1', value: '1' },
  { label: '2', value: '2' },
  { label: '3', value: '3' },
  { label: '4+', value: '4+' },
  { label: 'Any', value: 'any' },
];

const PROPERTY_TYPE_OPTIONS = [
  { label: 'Apartment', value: 'Apartment' },
  { label: 'Villa', value: 'Villa' },
  { label: 'Townhouse', value: 'Townhouse' },
  { label: 'Commercial', value: 'Commercial' },
];

const BUY_BUDGET_OPTIONS = [
  { label: 'Under AED 1M', value: 'budget:buy:under_1m' },
  { label: 'AED 1M–2M', value: 'budget:buy:1m_2m' },
  { label: 'AED 2M–5M', value: 'budget:buy:2m_5m' },
  { label: 'AED 5M+', value: 'budget:buy:5m_plus' },
  { label: 'Flexible', value: 'budget:flexible' },
];

const RENT_BUDGET_OPTIONS = [
  { label: 'Under AED 80K', value: 'budget:rent:under_80k' },
  { label: 'AED 80K–120K', value: 'budget:rent:80k_120k' },
  { label: 'AED 120K–200K', value: 'budget:rent:120k_200k' },
  { label: 'AED 200K+', value: 'budget:rent:200k_plus' },
  { label: 'Flexible', value: 'budget:flexible' },
];

const OFFPLAN_BUDGET_OPTIONS = [
  { label: 'Under AED 1M', value: 'budget:offplan:under_1m' },
  { label: 'AED 1M–2M', value: 'budget:offplan:1m_2m' },
  { label: 'AED 2M–5M', value: 'budget:offplan:2m_5m' },
  { label: 'AED 5M+', value: 'budget:offplan:5m_plus' },
  { label: 'Flexible', value: 'budget:flexible' },
];

const AFTER_RESULTS_OPTIONS = [
  { label: "I'm Interested", value: "I'm Interested" },
  { label: 'View Property', value: 'View Property' },
  { label: 'Refine Search', value: 'Refine Search' },
];

const FEW_RESULTS_OPTIONS = [
  { label: "I'm Interested", value: "I'm Interested" },
  { label: 'View Property', value: 'View Property' },
  { label: 'Refine Search', value: 'Refine Search' },
];

const MANY_RESULTS_REFINE_OPTIONS = [
  { label: 'Budget', value: 'Budget' },
  { label: 'Bedrooms', value: 'Bedrooms' },
  { label: 'Property Type', value: 'Property Type' },
  { label: 'Change Area', value: 'Change Area' },
];

const ZERO_RESULTS_OPTIONS = [
  { label: 'Show Similar Properties', value: 'Show Similar Properties' },
  { label: 'Change Budget', value: 'Change Budget' },
  { label: 'Change Area', value: 'Change Area' },
  { label: 'Change Search', value: 'Change Search' },
];

const BUDGET_ZERO_RECOVERY_OPTIONS = [
  { label: 'Show Closest Options', value: 'Show Closest Options' },
  { label: 'Change Budget', value: 'Change Budget' },
  { label: 'Change Area', value: 'Change Area' },
];

const PROPERTY_SELECTED_OPTIONS = [
  { label: 'Talk to an Agent', value: 'Talk to an Agent' },
  { label: 'Schedule a Viewing', value: 'Schedule a Viewing' },
  { label: 'WhatsApp Rocky', value: 'WhatsApp Rocky' },
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
  { label: 'Sell My Property', value: 'Sell My Property' },
  { label: 'Talk to Rocky', value: 'Talk to Rocky' },
  { label: 'WhatsApp Rocky', value: 'WhatsApp Rocky' },
];

const KNOWLEDGE_AREA_OPTIONS = [
  { label: 'Explore Areas', value: 'Explore Dubai Areas' },
  { label: 'Find Properties', value: 'View Properties' },
];

const KNOWLEDGE_GENERAL_OPTIONS = [
  { label: 'Find Properties', value: 'View Properties' },
  { label: 'Explore Areas', value: 'Explore Dubai Areas' },
];

const KNOWLEDGE_INVEST_OPTIONS = [
  { label: 'Explore Investment Properties', value: 'View Properties' },
  { label: 'Talk to an Agent', value: 'Talk to an Agent' },
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

const propertyTypeQuickActions = (includeCommercial = true) =>
  buildQuickActions(
    'What type of property are you looking for?',
    includeCommercial
      ? PROPERTY_TYPE_OPTIONS_WITH_COMMERCIAL
      : PROPERTY_TYPE_OPTIONS_CORE
  );

const locationQuickActions = () =>
  buildQuickActions('Which area are you interested in?', LOCATION_OPTIONS, {
    multiSelect: true,
  });

const bedroomQuickActions = () =>
  buildQuickActions('How many bedrooms are you looking for?', BEDROOM_OPTIONS);

/**
 * @param {'buy'|'rent'|'off-plan'|null} listingType
 */
const budgetQuickActions = (listingType) => {
  if (listingType === 'rent') {
    return buildQuickActions('What budget are you looking for?', RENT_BUDGET_OPTIONS);
  }
  if (listingType === 'off-plan') {
    return buildQuickActions('What budget are you looking for?', OFFPLAN_BUDGET_OPTIONS);
  }
  return buildQuickActions('What budget are you looking for?', BUY_BUDGET_OPTIONS);
};

const sellPropertyTypeQuickActions = () =>
  buildQuickActions('What type of property are you looking to sell?', PROPERTY_TYPE_OPTIONS);

const afterResultsQuickActions = () =>
  buildQuickActions(
    'Would you like to continue with one of these properties?',
    AFTER_RESULTS_OPTIONS
  );

const fewResultsQuickActions = () =>
  buildQuickActions(
    'Would you like to continue with one of these properties?',
    FEW_RESULTS_OPTIONS
  );

const manyResultsRefineQuickActions = () =>
  buildQuickActions(
    'Want to narrow them down?',
    MANY_RESULTS_REFINE_OPTIONS
  );

const zeroResultsRecoveryQuickActions = () =>
  buildQuickActions(
    'Would you like to try nearby options?',
    ZERO_RESULTS_OPTIONS
  );

const budgetZeroRecoveryQuickActions = () =>
  buildQuickActions(
    'Would you like to see the closest available options?',
    BUDGET_ZERO_RECOVERY_OPTIONS
  );

const propertySelectedQuickActions = () =>
  buildQuickActions(
    'Great choice. How would you like to proceed?',
    PROPERTY_SELECTED_OPTIONS
  );

const highIntentQuickActions = () =>
  buildQuickActions(
    'How would you like to continue?',
    HIGH_INTENT_OPTIONS
  );

const serviceMenuQuickActions = () =>
  buildQuickActions('Which service would you like to explore?', SERVICE_MENU_OPTIONS);

const servicePmQuickActions = () =>
  buildQuickActions(
    'Would you like to speak with our Property Management team?',
    SERVICE_PM_OPTIONS
  );

const sellDoneQuickActions = () =>
  buildQuickActions('Thanks. Would you like our team to contact you?', SELL_DONE_OPTIONS);

const knowledgeAreaQuickActions = () =>
  buildQuickActions('What would you like to do next?', KNOWLEDGE_AREA_OPTIONS);

const knowledgeGeneralQuickActions = () =>
  buildQuickActions('What would you like to do next?', KNOWLEDGE_GENERAL_OPTIONS);

const knowledgeInvestQuickActions = () =>
  buildQuickActions('What would you like to do next?', KNOWLEDGE_INVEST_OPTIONS);

module.exports = {
  buildQuickActions,
  greetingQuickActions,
  listingTypeQuickActions,
  propertyTypeQuickActions,
  locationQuickActions,
  bedroomQuickActions,
  budgetQuickActions,
  sellPropertyTypeQuickActions,
  afterResultsQuickActions,
  fewResultsQuickActions,
  manyResultsRefineQuickActions,
  zeroResultsRecoveryQuickActions,
  budgetZeroRecoveryQuickActions,
  propertySelectedQuickActions,
  highIntentQuickActions,
  serviceMenuQuickActions,
  servicePmQuickActions,
  sellDoneQuickActions,
  knowledgeAreaQuickActions,
  knowledgeGeneralQuickActions,
  knowledgeInvestQuickActions,
  LISTING_TYPE_OPTIONS,
  BEDROOM_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  PROPERTY_TYPE_OPTIONS_CORE,
  LOCATION_OPTIONS,
  YES_NO_OPTIONS,
  GREETING_OPTIONS,
};
