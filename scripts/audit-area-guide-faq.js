/**
 * READ-ONLY audit: Area Guides + FAQs for Phase 4 knowledge RAG planning.
 *
 * Usage:
 *   node scripts/audit-area-guide-faq.js
 *
 * Does NOT:
 * - call OpenAI
 * - modify MongoDB
 * - create embeddings
 * - touch Blog RAG
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AreaGuide = require('../src/models/AreaGuide');
const Faq = require('../src/models/Faq');
const { FAQ_PAGES } = Faq;

const looksLikeHtml = (text) => /<\/?[a-z][\s\S]*>/i.test(String(text || ''));
const looksLikeUrl = (text) => /https?:\/\//i.test(String(text || ''));
const avgLen = (arr) =>
  arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const areaColl = AreaGuide.collection.collectionName;
  const faqColl = Faq.collection.collectionName;

  const areaTotal = await AreaGuide.countDocuments();
  const areaActive = await AreaGuide.countDocuments({ isActive: true });
  const areaInactive = await AreaGuide.countDocuments({ isActive: false });

  const faqTotal = await Faq.countDocuments();
  const faqActive = await Faq.countDocuments({ isActive: true });
  const faqInactive = await Faq.countDocuments({ isActive: false });

  const areaGuides = await AreaGuide.find({}).sort({ order: 1 }).lean();
  const faqs = await Faq.find({}).sort({ page: 1, order: 1 }).lean();

  const areaSamples = areaGuides.slice(0, 5).map((g) => ({
    _id: String(g._id),
    order: g.order,
    slug: g.slug,
    title: g.title,
    isActive: g.isActive,
    aboutLength: (g.about || '').length,
    aboutPreview: String(g.about || '').slice(0, 220),
    keyHighlightsCount: Array.isArray(g.keyHighlights) ? g.keyHighlights.length : 0,
    keyHighlightsSample: (g.keyHighlights || []).slice(0, 3),
    agentOrders: g.agentOrders || [],
    mapQuery: g.mapQuery,
    image: g.image ? String(g.image).slice(0, 120) : null,
    path: g.path || null,
    listingsSearch: g.listingsSearch || null,
    aboutLooksHtml: looksLikeHtml(g.about),
    aboutHasUrl: looksLikeUrl(g.about),
    keys: Object.keys(g),
  }));

  const areaFieldStats = {
    withAbout: areaGuides.filter((g) => g.about && String(g.about).trim()).length,
    withImage: areaGuides.filter((g) => g.image).length,
    withPath: areaGuides.filter((g) => g.path).length,
    withListingsSearch: areaGuides.filter(
      (g) => Array.isArray(g.listingsSearch) && g.listingsSearch.length
    ).length,
    withAgentOrders: areaGuides.filter(
      (g) => Array.isArray(g.agentOrders) && g.agentOrders.length
    ).length,
    withKeyHighlights: areaGuides.filter(
      (g) => Array.isArray(g.keyHighlights) && g.keyHighlights.length
    ).length,
    aboutHtmlCount: areaGuides.filter((g) => looksLikeHtml(g.about)).length,
    aboutUrlCount: areaGuides.filter((g) => looksLikeUrl(g.about)).length,
    aboutLengths: areaGuides.map((g) => String(g.about || '').length),
    highlightTitleLengths: areaGuides.flatMap((g) =>
      (g.keyHighlights || []).map((h) => String(h.title || '').length)
    ),
  };

  const faqByPage = {};
  for (const page of Object.values(FAQ_PAGES)) {
    faqByPage[page] = {
      total: faqs.filter((f) => f.page === page).length,
      active: faqs.filter((f) => f.page === page && f.isActive !== false).length,
      withSlug: faqs.filter((f) => f.page === page && f.slug).length,
    };
  }

  const faqSamples = faqs.slice(0, 8).map((f) => ({
    _id: String(f._id),
    page: f.page,
    slug: f.slug,
    order: f.order,
    isActive: f.isActive,
    question: f.question,
    answerLength: String(f.answer || '').length,
    answerPreview: String(f.answer || '').slice(0, 220),
    answerLooksHtml: looksLikeHtml(f.answer),
    answerHasUrl: looksLikeUrl(f.answer),
    keys: Object.keys(f),
  }));

  const faqFieldStats = {
    withSlug: faqs.filter((f) => f.slug).length,
    withoutSlug: faqs.filter((f) => !f.slug).length,
    answerHtmlCount: faqs.filter((f) => looksLikeHtml(f.answer)).length,
    questionHtmlCount: faqs.filter((f) => looksLikeHtml(f.question)).length,
    answerUrlCount: faqs.filter((f) => looksLikeUrl(f.answer)).length,
    questionLengths: faqs.map((f) => String(f.question || '').length),
    answerLengths: faqs.map((f) => String(f.answer || '').length),
  };

  // Distinct FAQ slugs for area-guide page (linked to area guides)
  const areaGuideFaqs = faqs.filter((f) => f.page === 'area-guide');
  const areaGuideFaqSlugs = [...new Set(areaGuideFaqs.map((f) => f.slug).filter(Boolean))];

  const areaSlugs = areaGuides.map((g) => g.slug);
  const faqSlugsMatchingGuides = areaGuideFaqSlugs.filter((s) => areaSlugs.includes(s));

  console.log(
    JSON.stringify(
      {
        readOnly: true,
        openaiCalled: false,
        mongoWrites: false,
        collections: {
          areaGuides: areaColl,
          faqs: faqColl,
        },
        areaGuides: {
          total: areaTotal,
          active: areaActive,
          inactive: areaInactive,
          slugs: areaSlugs,
          titles: areaGuides.map((g) => ({ slug: g.slug, title: g.title, isActive: g.isActive })),
          fieldStats: {
            ...areaFieldStats,
            avgAboutLength: avgLen(areaFieldStats.aboutLengths),
            maxAboutLength: Math.max(0, ...areaFieldStats.aboutLengths),
            minAboutLength: Math.min(...areaFieldStats.aboutLengths, Infinity) || 0,
            avgHighlightTitleLength: avgLen(areaFieldStats.highlightTitleLengths),
          },
          samples: areaSamples,
          schemaFieldsFromModel: [
            'order',
            'slug',
            'title',
            'about',
            'keyHighlights',
            'agentOrders',
            'mapQuery',
            'image',
            'path',
            'listingsSearch',
            'isActive',
            'createdAt',
            'updatedAt',
            '_id',
          ],
        },
        faqs: {
          total: faqTotal,
          active: faqActive,
          inactive: faqInactive,
          byPage: faqByPage,
          fieldStats: {
            ...faqFieldStats,
            avgQuestionLength: avgLen(faqFieldStats.questionLengths),
            avgAnswerLength: avgLen(faqFieldStats.answerLengths),
            maxAnswerLength: Math.max(0, ...faqFieldStats.answerLengths),
            minAnswerLength: Math.min(...faqFieldStats.answerLengths, Infinity) || 0,
          },
          areaGuideLinked: {
            faqCount: areaGuideFaqs.length,
            distinctSlugs: areaGuideFaqSlugs,
            slugsMatchingAreaGuides: faqSlugsMatchingGuides,
          },
          samples: faqSamples,
          allowedPages: Object.values(FAQ_PAGES),
          schemaFieldsFromModel: [
            'page',
            'slug',
            'question',
            'answer',
            'order',
            'isActive',
            'createdAt',
            'updatedAt',
            '_id',
          ],
        },
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
})().catch(async (error) => {
  console.error('Audit failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
