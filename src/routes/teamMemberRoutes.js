const express = require('express');
const router = express.Router();

const {
  createTeamMember,
  getTeamMembers,
  getTeamMemberById,
  getTeamMemberBySlug,
  updateTeamMember,
  deleteTeamMember,
} = require('../controllers/teamMemberController');

// 1. Create Team Member - POST /api/team-members
router.post('/', createTeamMember);

// 2. Get all Team Members - GET /api/team-members
router.get('/', getTeamMembers);

// 3. Get Team Member by slug - GET /api/team-members/slug/:slug
// Must be registered before /:id to avoid treating "slug" as an ObjectId
router.get('/slug/:slug', getTeamMemberBySlug);

// 4. Get Team Member by id - GET /api/team-members/:id
router.get('/:id', getTeamMemberById);

// 5. Update Team Member - PUT /api/team-members/:id
router.put('/:id', updateTeamMember);

// 6. Delete Team Member - DELETE /api/team-members/:id
router.delete('/:id', deleteTeamMember);

module.exports = router;
