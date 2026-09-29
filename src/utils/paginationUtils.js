const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Parses and validates pagination params from request query
 * @param {object} req - Express request object
 * @param {object} options - { defaultPage, defaultLimit, maxLimit }
 * @returns {{ page: number, limit: number }}
 */
const parsePaginationParams = (req, options = {}) => {
    const {
        defaultPage = DEFAULT_PAGE,
        defaultLimit = DEFAULT_LIMIT,
        maxLimit = MAX_LIMIT
    } = options;

    const page = Math.max(1, parseInt(req.query.page, 10) || defaultPage);
    const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));

    return { page, limit };
};

module.exports = {
    parsePaginationParams,
    DEFAULT_PAGE,
    DEFAULT_LIMIT,
    MAX_LIMIT
};
