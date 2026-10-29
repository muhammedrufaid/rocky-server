const TeamTailorJob = require('../models/TeamTailorJob');
const {
  fetchJobsFromApi,
  fetchJobByIdFromApi,
  syncJobsToDb,
} = require('../services/teamtailorService');

/**
 * Newest Teamtailor creation date first.
 * Matches MongoDB `{ teamtailorCreatedAt: -1, teamtailorId: -1 }`:
 * missing dates sort last, then teamtailorId descending as a string.
 */
const compareByTeamtailorCreatedAt = (a, b) => {
  const aTime = a?.teamtailorCreatedAt ? new Date(a.teamtailorCreatedAt).getTime() : NaN;
  const bTime = b?.teamtailorCreatedAt ? new Date(b.teamtailorCreatedAt).getTime() : NaN;
  const aHas = Number.isFinite(aTime);
  const bHas = Number.isFinite(bTime);

  if (aHas && bHas && aTime !== bTime) return bTime - aTime;
  if (aHas !== bHas) return aHas ? -1 : 1;

  const aId = String(a?.teamtailorId ?? '');
  const bId = String(b?.teamtailorId ?? '');
  if (aId === bId) return 0;
  return aId < bId ? 1 : -1;
};

/** Teamtailor job ids currently shown by GET /api/teamtailor/jobs. */
const VISIBLE_JOB_IDS = ['8498182', '8146655', '8146326', '8130814', '8113253'];

/**
 * GET /api/teamtailor/jobs
 * Returns jobs stored in MongoDB (synced from TeamTailor).
 * Query: ?live=true to fetch directly from TeamTailor API instead.
 * Order is Teamtailor's created-at (teamtailorCreatedAt), newest first.
 * Only VISIBLE_JOB_IDS are included.
 */
const getJobs = async (req, res) => {
  try {
    const live = String(req.query.live || '').toLowerCase() === 'true';

    if (live) {
      const jobs = (await fetchJobsFromApi())
        .filter((job) => VISIBLE_JOB_IDS.includes(String(job?.teamtailorId ?? '')))
        .sort(compareByTeamtailorCreatedAt);
      return res.status(200).json({
        success: true,
        source: 'teamtailor',
        count: jobs.length,
        data: jobs,
      });
    }

    const filter = { teamtailorId: { $in: VISIBLE_JOB_IDS } };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.humanStatus) filter.humanStatus = req.query.humanStatus;

    const jobs = await TeamTailorJob.find(filter).sort({
      teamtailorCreatedAt: -1,
      teamtailorId: -1,
    });

    return res.status(200).json({
      success: true,
      source: 'database',
      count: jobs.length,
      data: jobs,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch TeamTailor jobs',
    });
  }
};

/**
 * GET /api/teamtailor/jobs/:id
 * Returns a job by TeamTailor id from MongoDB.
 * Query: ?live=true to fetch directly from TeamTailor API instead.
 */
const getJobById = async (req, res) => {
  try {
    const { id } = req.params;
    const live = String(req.query.live || '').toLowerCase() === 'true';

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Job id is required',
      });
    }

    if (live) {
      const job = await fetchJobByIdFromApi(id);
      if (!job) {
        return res.status(404).json({
          success: false,
          message: 'TeamTailor job not found',
        });
      }

      return res.status(200).json({
        success: true,
        source: 'teamtailor',
        data: job,
      });
    }

    const job = await TeamTailorJob.findOne({ teamtailorId: String(id) });
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'TeamTailor job not found',
      });
    }

    return res.status(200).json({
      success: true,
      source: 'database',
      data: job,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch TeamTailor job',
    });
  }
};

/**
 * POST /api/teamtailor/sync
 * Fetches jobs from TeamTailor and syncs MongoDB:
 * adds new jobs, updates changed jobs, removes deleted jobs.
 */
const syncJobs = async (req, res) => {
  try {
    const result = await syncJobsToDb();

    return res.status(200).json({
      success: true,
      message: result.count
        ? 'TeamTailor jobs synced successfully'
        : 'No jobs found in TeamTailor',
      count: result.count,
      upserted: result.upserted,
      modified: result.modified,
      deleted: result.deleted,
      staleIds: result.staleIds,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to sync TeamTailor jobs',
    });
  }
};

module.exports = {
  getJobs,
  getJobById,
  syncJobs,
};
