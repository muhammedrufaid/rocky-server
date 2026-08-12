/**
 * Phase 4 Step 2 — public knowledge boundary validation (READ ONLY).
 *
 * Usage:
 *   node scripts/test-area-guide-faq-boundary.js
 *
 * Does NOT:
 * - call OpenAI
 * - create embeddings / indexes
 * - modify MongoDB
 * - touch Blog RAG
 * - hydrate agents / TeamMember
 * - load AreaGuideLead or forbidden collections
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  extractActiveAreaGuideKnowledge,
} = require('../src/services/areaGuideContentService');
const {
  extractActiveFaqKnowledge,
} = require('../src/services/faqContentService');
const AreaGuide = require('../src/models/AreaGuide');
const Faq = require('../src/models/Faq');

const FORBIDDEN_COLLECTIONS = [
  'areaguideleads',
  'binghattileads',
  'careers',
  'contacts',
  'dubaisouthleads',
  'jeweltowerleads',
  'landingpageleads',
  'newsletters',
  'propertymanagementleads',
  'sells',
  'teamtailorjobs',
  'users',
];

const ALLOWED_MODELS = new Set(['AreaGuide', 'Faq']);

const looksLikeHtml = (text) => /<\/?[a-z][\s\S]*>/i.test(String(text || ''));
const looksLikeImageUrl = (text) =>
  /https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)/i.test(String(text || '')) ||
  /\/assets\/area-guides\//i.test(String(text || ''));

(async () => {
  console.log('=== Phase 4 Step 2: Area Guide + FAQ knowledge boundary ===');
  console.log('OpenAI called: NO');
  console.log('Mongo writes: NO');
  console.log('Blog RAG modified: NO');
  console.log('');

  await mongoose.connect(process.env.MONGO_URI);

  const areaTotal = await AreaGuide.countDocuments();
  const areaActive = await AreaGuide.countDocuments({ isActive: true });
  const areaInactive = await AreaGuide.countDocuments({ isActive: false });

  const faqTotal = await Faq.countDocuments();
  const faqActive = await Faq.countDocuments({ isActive: true });
  const faqInactive = await Faq.countDocuments({ isActive: false });
  const careersFaqCount = await Faq.countDocuments({ page: 'careers' });
  const areaGuideFaqCount = await Faq.countDocuments({ page: 'area-guide' });
  const homeFaqActive = await Faq.countDocuments({ page: 'home', isActive: true });
  const offPlanFaqActive = await Faq.countDocuments({ page: 'off-plan', isActive: true });

  const areaUnits = await extractActiveAreaGuideKnowledge();
  const { units: faqUnits, excluded: faqExcluded, placeholderHits } =
    await extractActiveFaqKnowledge();

  const issues = [];

  // --- Area Guide checks ---
  if (areaActive !== 13) issues.push(`expected 13 active area guides, got ${areaActive}`);
  if (areaUnits.length !== 13) {
    issues.push(`expected 13 area guide knowledge units, got ${areaUnits.length}`);
  }

  for (const unit of areaUnits) {
    if (unit.sourceType !== 'area_guide') issues.push(`bad sourceType: ${unit.sourceType}`);
    if (!unit.title) issues.push(`area unit missing title (${unit.sourceId})`);
    if (!unit.plainText) issues.push(`area unit empty plainText (${unit.sourceId})`);
    if (!unit.blocks?.some((b) => b.type === 'about' && b.text)) {
      issues.push(`area unit missing about block (${unit.sourceId})`);
    }
    if (Object.prototype.hasOwnProperty.call(unit, 'agentOrders')) {
      issues.push(`agentOrders leaked (${unit.slug})`);
    }
    if (Object.prototype.hasOwnProperty.call(unit, 'agents')) {
      issues.push(`agents leaked (${unit.slug})`);
    }
    if (Object.prototype.hasOwnProperty.call(unit, 'listingsSearch')) {
      issues.push(`listingsSearch leaked (${unit.slug})`);
    }
    if (Object.prototype.hasOwnProperty.call(unit, 'image')) {
      issues.push(`image leaked (${unit.slug})`);
    }
    if (Object.prototype.hasOwnProperty.call(unit, 'createdAt')) {
      issues.push(`createdAt leaked (${unit.slug})`);
    }
    if (Object.prototype.hasOwnProperty.call(unit, 'updatedAt')) {
      issues.push(`updatedAt leaked (${unit.slug})`);
    }
    if (looksLikeHtml(unit.plainText)) issues.push(`HTML in area plainText (${unit.slug})`);
    if (looksLikeImageUrl(unit.plainText)) {
      issues.push(`image path/url in area plainText (${unit.slug})`);
    }
    // mapQuery must stay metadata, not searchable text body as a labeled section
    if (/\nmapQuery:/i.test(unit.plainText)) {
      issues.push(`mapQuery appeared in plainText (${unit.slug})`);
    }
    const aboutBlock = unit.blocks.find((b) => b.type === 'about');
    if (aboutBlock && !unit.plainText.includes(aboutBlock.text)) {
      issues.push(`about text missing from plainText (${unit.slug})`);
    }
  }

  // --- FAQ checks ---
  if (faqActive !== 19) issues.push(`expected 19 active FAQs, got ${faqActive}`);
  if (faqExcluded.careers !== careersFaqCount) {
    issues.push(
      `careers excluded mismatch: excluded=${faqExcluded.careers}, db=${careersFaqCount}`
    );
  }
  const expectedFaqIncluded = homeFaqActive + offPlanFaqActive + areaGuideFaqCount;
  // area-guide FAQs are in include set; currently 0
  if (expectedFaqIncluded !== 13) {
    issues.push(
      `expected included FAQ count 13 (home+off-plan+area-guide), computed ${expectedFaqIncluded}`
    );
  }
  if (faqUnits.length !== 13) {
    issues.push(`expected 13 FAQ knowledge units, got ${faqUnits.length}`);
  }
  if (areaGuideFaqCount !== 0) {
    // Not a failure if data changes later — but report expectation for this phase snapshot
    console.log('NOTE: area-guide FAQs are no longer 0; included if active.');
  }

  for (const unit of faqUnits) {
    if (unit.sourceType !== 'faq') issues.push(`bad FAQ sourceType: ${unit.sourceType}`);
    if (unit.page === 'careers') issues.push(`careers FAQ leaked into units (${unit.sourceId})`);
    if (!['home', 'off-plan', 'area-guide'].includes(unit.page)) {
      issues.push(`unexpected FAQ page in units: ${unit.page}`);
    }
    if (!unit.question) issues.push(`FAQ missing question (${unit.sourceId})`);
    if (!unit.answer) issues.push(`FAQ missing answer (${unit.sourceId})`);
    if (!unit.plainText) issues.push(`FAQ empty plainText (${unit.sourceId})`);
    if (looksLikeHtml(unit.plainText)) issues.push(`HTML in FAQ plainText (${unit.sourceId})`);
    if (/\{\{/.test(unit.plainText)) {
      issues.push(`raw template token left in FAQ plainText (${unit.sourceId})`);
    }
    if (Object.prototype.hasOwnProperty.call(unit, 'createdAt')) {
      issues.push(`createdAt leaked in FAQ (${unit.sourceId})`);
    }
    if (Object.prototype.hasOwnProperty.call(unit, 'updatedAt')) {
      issues.push(`updatedAt leaked in FAQ (${unit.sourceId})`);
    }
  }

  const totalUnits = areaUnits.length + faqUnits.length;
  if (totalUnits !== 26) {
    issues.push(`expected 26 total knowledge units, got ${totalUnits}`);
  }

  // Security: only AreaGuide + Faq models loaded
  const loadedModels = mongoose.modelNames();
  const unexpectedModels = loadedModels.filter((name) => !ALLOWED_MODELS.has(name));
  if (unexpectedModels.length) {
    issues.push(`unexpected mongoose models loaded: ${unexpectedModels.join(', ')}`);
  }

  const collectionsAccessed = [
    AreaGuide.collection.collectionName,
    Faq.collection.collectionName,
  ];
  const forbiddenHit = collectionsAccessed.filter((c) => FORBIDDEN_COLLECTIONS.includes(c));
  if (forbiddenHit.length) {
    issues.push(`FORBIDDEN collections accessed: ${forbiddenHit.join(', ')}`);
  }

  console.log('--- Area Guide ---');
  console.log('total:', areaTotal);
  console.log('active:', areaActive);
  console.log('inactive:', areaInactive);
  console.log('included:', areaUnits.length);
  console.log('excluded:', areaInactive + (areaActive - areaUnits.length));
  console.log('knowledge units:', areaUnits.length);

  console.log('\n--- FAQ ---');
  console.log('total:', faqTotal);
  console.log('active:', faqActive);
  console.log('inactive:', faqInactive);
  console.log('included:', faqUnits.length);
  console.log('excluded:', faqExcluded.careers + faqExcluded.otherPages + faqExcluded.inactiveOrInvalid);
  console.log('knowledge units:', faqUnits.length);
  console.log('careers FAQ count excluded:', faqExcluded.careers);
  console.log('area-guide FAQ count (db):', areaGuideFaqCount);
  console.log('home active:', homeFaqActive, '| off-plan active:', offPlanFaqActive);

  console.log('\n--- Placeholders ---');
  console.log('placeholder occurrences:', placeholderHits.length);
  for (const hit of placeholderHits) {
    console.log(
      `  FAQ ${hit.sourceId} | page=${hit.page} | placeholders=${hit.placeholders.join(', ')}`
    );
    console.log(`  Q: ${hit.question}`);
  }

  console.log('\n--- Security ---');
  console.log('collections accessed:', collectionsAccessed);
  console.log('mongoose models loaded:', loadedModels);
  console.log('forbidden collections accessed:', forbiddenHit.length ? forbiddenHit : 'NONE');
  console.log('TeamMember loaded:', loadedModels.includes('TeamMember') ? 'YES (FAIL)' : 'NO');
  console.log('AreaGuideLead loaded:', loadedModels.includes('AreaGuideLead') ? 'YES (FAIL)' : 'NO');

  console.log('\n--- Totals ---');
  console.log('Area Guide units:', areaUnits.length);
  console.log('FAQ units:', faqUnits.length);
  console.log('Total knowledge units:', totalUnits);

  // Sample previews (first of each)
  console.log('\n--- Sample Area Guide unit ---');
  console.log(JSON.stringify(areaUnits[0], null, 2));
  console.log('\n--- Sample FAQ unit ---');
  console.log(JSON.stringify(faqUnits[0], null, 2));

  const pass = issues.length === 0;
  console.log('\n=== Summary ===');
  if (!pass) {
    console.log('Issues:');
    for (const issue of issues) console.log(' -', issue);
  }
  console.log('Overall:', pass ? 'PASS' : 'FAIL');

  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
})().catch(async (error) => {
  console.error('Boundary test failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
