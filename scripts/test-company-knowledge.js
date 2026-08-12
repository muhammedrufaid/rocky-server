/**
 * Validate the static public company knowledge file.
 *
 * Usage:
 *   node scripts/test-company-knowledge.js
 *
 * Does NOT call OpenAI.
 * Does NOT modify MongoDB.
 * Does NOT create embeddings.
 */
const fs = require('fs');
const path = require('path');

const COMPANY_MD_PATH = path.join(__dirname, '..', 'src', 'ai', 'knowledge', 'company.md');

const REQUIRED_CHECKS = [
  { id: 'file_exists', description: 'company.md exists' },
  { id: 'company_name', description: 'Company name present', pattern: /###\s*Company Name\s*\n+Rocky Real Estate/i },
  { id: 'owner', description: 'Owner present', pattern: /###\s*Owner\s*\n+Ashok Uttamchandani/i },
  { id: 'founder', description: 'Founder present', pattern: /###\s*Founder\s*\n+Ashok Uttamchandani/i },
  { id: 'director', description: 'Director present', pattern: /###\s*Director\s*\n+Kiran Uttamchandani/i },
  { id: 'established', description: 'Established year present', pattern: /###\s*Established\s*\n+1976/i },
  { id: 'head_office', description: 'Head office present', pattern: /##\s*Head Office\s*\n+Al Khaimah 2, Al Barsha 1, Dubai/i },
  { id: 'website', description: 'Website present', pattern: /https:\/\/www\.rockyrealestate\.com\//i },
  { id: 'about', description: 'About section present', pattern: /###\s*About Rocky Real Estate[\s\S]*Since 1976/i },
  { id: 'key_strengths', description: 'Key strengths present', pattern: /##\s*Key Strengths[\s\S]*Exclusive Listings[\s\S]*End-to-End Support[\s\S]*Deep Market Knowledge[\s\S]*Transparent Advisory/i },
  {
    id: 'no_service_duplication',
    description: 'Services section points to MongoDB services collection',
    pattern: /##\s*Services[\s\S]*services` collection/i,
  },
  {
    id: 'public_boundary',
    description: 'Public information boundary present',
    pattern: /##\s*Public Information Boundary[\s\S]*confidential business information/i,
  },
];

const FORBIDDEN_INVENTIONS = [
  { id: 'no_phone', pattern: /\+?\d[\d\s()-]{7,}\d/, label: 'phone number' },
  { id: 'no_email', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, label: 'email address' },
  { id: 'no_employee_count', pattern: /\b\d+\s+(employees|agents|staff)\b/i, label: 'employee/agent count' },
  { id: 'no_revenue', pattern: /\brevenue\b|\bAED\s?\d/i, label: 'revenue/currency amount' },
];

(async () => {
  console.log('=== Company knowledge validation ===');
  console.log('Path:', COMPANY_MD_PATH);
  console.log('OpenAI called: NO');
  console.log('MongoDB modified: NO\n');

  const results = [];

  const exists = fs.existsSync(COMPANY_MD_PATH);
  results.push({ id: 'file_exists', pass: exists, description: 'company.md exists' });

  if (!exists) {
    console.error('FAIL: company.md not found');
    process.exit(1);
  }

  const content = fs.readFileSync(COMPANY_MD_PATH, 'utf8');

  for (const check of REQUIRED_CHECKS) {
    if (check.id === 'file_exists') continue;
    const pass = check.pattern.test(content);
    results.push({ id: check.id, pass, description: check.description });
  }

  for (const forbidden of FORBIDDEN_INVENTIONS) {
    const found = forbidden.pattern.test(content);
    results.push({
      id: forbidden.id,
      pass: !found,
      description: `Must not invent/include ${forbidden.label}`,
    });
  }

  for (const result of results) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'} — ${result.description}`);
  }

  const allPass = results.every((r) => r.pass);
  console.log(`\nOverall: ${allPass ? 'PASS' : 'FAIL'}`);
  process.exit(allPass ? 0 : 1);
})().catch((error) => {
  console.error('Validation failed:', error.message);
  process.exit(1);
});
