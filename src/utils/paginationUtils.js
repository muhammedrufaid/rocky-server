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

/**
 * Paginates an array and returns items with pagination metadata
 * @param {Array} items - Full array of items
 * @param {number} page - Current page (1-based)
 * @param {number} limit - Items per page
 * @returns {{ items: Array, total: number, pagination: object }}
 */
const paginate = (items, page = DEFAULT_PAGE, limit = DEFAULT_LIMIT) => {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(MAX_LIMIT, Math.max(1, limit));
    const total = Array.isArray(items) ? items.length : 0;
    const skip = (safePage - 1) * safeLimit;
    const paginatedItems = Array.isArray(items) ? items.slice(skip, skip + safeLimit) : [];
    const totalPages = total > 0 ? Math.ceil(total / safeLimit) : 0;

    return {
        items: paginatedItems,
        total,
        pagination: {
            page: safePage,
            limit: safeLimit,
            totalPages,
            hasNext: safePage < totalPages,
            hasPrev: safePage > 1
        }
    };
};

module.exports = {
    parsePaginationParams,
    paginate,
    DEFAULT_PAGE,
    DEFAULT_LIMIT,
    MAX_LIMIT
};
