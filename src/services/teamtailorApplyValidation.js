class ApplyError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApplyError';
    this.status = options.status || 500;
    this.code = options.code || 'apply_error';
    this.retryable = Boolean(options.retryable);
    this.logDetail = options.logDetail;
  }
}

function splitFullName(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length < 2) {
    throw new ApplyError('Please enter both your first and last name.', {
      status: 400,
      code: 'invalid_name',
    });
  }

  return {
    fullName: parts.join(' '),
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

function isValidPhone(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function normalizePersonName(value, label, code) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) {
    throw new ApplyError(`${label} is required.`, { status: 400, code });
  }
  if (name.length > 80) {
    throw new ApplyError(`${label} is too long.`, { status: 400, code: 'invalid_name' });
  }
  return name;
}

function validateApplicant(body = {}) {
  const firstName = normalizePersonName(body.firstName, 'First name', 'missing_first_name');
  const lastName = normalizePersonName(body.lastName, 'Last name', 'missing_last_name');
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  const teamtailorJobId = String(body.teamtailorJobId || '').trim();

  if (!email) {
    throw new ApplyError('Email is required.', { status: 400, code: 'missing_email' });
  }
  if (!isValidEmail(email)) {
    throw new ApplyError('Please enter a valid email address.', {
      status: 400,
      code: 'invalid_email',
    });
  }

  if (!phone) {
    throw new ApplyError('Phone number is required.', { status: 400, code: 'missing_phone' });
  }
  if (!isValidPhone(phone)) {
    throw new ApplyError('Please enter a valid phone number, including the country code.', {
      status: 400,
      code: 'invalid_phone',
    });
  }

  if (!teamtailorJobId) {
    throw new ApplyError('A job is required.', { status: 400, code: 'missing_job' });
  }
  if (!/^\d{1,32}$/.test(teamtailorJobId)) {
    throw new ApplyError('Job not found.', { status: 404, code: 'job_not_found' });
  }

  if (body.privacyAccepted != null && String(body.privacyAccepted) !== 'true') {
    throw new ApplyError('Please accept the privacy notice before applying.', {
      status: 400,
      code: 'consent_required',
    });
  }

  return {
    fullName: `${firstName} ${lastName}`,
    firstName,
    lastName,
    email,
    phone,
    teamtailorJobId,
  };
}

function isEligibleJob(job) {
  if (!job) return false;
  const status = String(job.status || '').toLowerCase();
  const humanStatus = String(job.humanStatus || '').toLowerCase();
  return status === 'open' && humanStatus === 'published' && job.internal !== true;
}

function redactForLog(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\+[1-9]\d{7,14}/g, '[redacted-phone]')
    .slice(0, 300);
}

module.exports = {
  ApplyError,
  splitFullName,
  validateApplicant,
  isEligibleJob,
  redactForLog,
};
