/**
 * Teamtailor in this backend is a recruitment client.
 * requestTeamtailor() creates candidates, CV uploads, and job applications.
 * Candidate attributes are first name, last name, email, phone, and resume.
 * There is no customer location or country attribute to reuse.
 * locations[].country on a job is the office attached to that job.
 * Custom field values also belong to candidates, so creating one would still
 * add a relocation customer to the careers pipeline.
 * This function records that limit and does not call Teamtailor.
 */
function syncRelocationEnquiry() {
  return {
    status: 'skipped',
    recordId: null,
    error: null,
  };
}

module.exports = {
  syncRelocationEnquiry,
};
