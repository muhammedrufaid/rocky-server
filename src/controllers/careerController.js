const https = require('https');
const mongoose = require('mongoose');
const Career = require('../models/Career');
const cloudinary = require('../config/cloudinary');
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');
const { sendCareerToGoogleSheet } = require('../services/googleSheetsService');

function getFormatFromFilename(filename) {
  const match = String(filename || '').match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : undefined;
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }

  const protocol =
    req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function buildCvViewUrl(req, careerId) {
  return `${getPublicBaseUrl(req)}/api/career/${careerId}/cv/view`;
}

function buildCvDownloadUrl(req, careerId) {
  return `${getPublicBaseUrl(req)}/api/career/${careerId}/cv/download`;
}

// Cloudinary stores raw CV public_id with extension (e.g. ...PM.pdf).
function resolveCloudinaryPublicId(cvPublicId, updatedFileName, originalFileName) {
  const id = String(cvPublicId || '').trim();
  if (!id) return id;
  if (/\.(pdf|doc|docx)$/i.test(id)) return id;

  const format =
    getFormatFromFilename(updatedFileName) || getFormatFromFilename(originalFileName);
  return format ? `${id}.${format}` : id;
}

function buildCloudinaryDownloadUrl(publicId, format, { attachment } = {}) {
  const options = { resource_type: 'raw', type: 'upload' };
  if (attachment) options.attachment = attachment;
  return cloudinary.utils.private_download_url(publicId, format, options);
}

function streamCvFromCloudinary(downloadUrl, res, { contentType, disposition, filename }) {
  return new Promise((resolve, reject) => {
    https
      .get(downloadUrl, (cloudRes) => {
        if (cloudRes.statusCode && cloudRes.statusCode >= 400) {
          cloudRes.resume();
          reject(new Error(`Failed to fetch CV (${cloudRes.statusCode})`));
          return;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
        cloudRes.pipe(res);
        cloudRes.on('end', resolve);
        cloudRes.on('error', reject);
      })
      .on('error', reject);
  });
}

async function streamCareerCv(career, res, { download = false } = {}) {
  const displayName =
    career.cvUpdatedFileName || career.cvOriginalFileName || career.cvFileName || 'cv';
  const publicId = resolveCloudinaryPublicId(
    career.cvPublicId,
    career.cvUpdatedFileName,
    career.cvOriginalFileName
  );
  const format =
    getFormatFromFilename(displayName) ||
    getFormatFromFilename(publicId) ||
    getFormatFromFilename(career.cvOriginalFileName);

  const downloadUrl = buildCloudinaryDownloadUrl(publicId, format, {
    attachment: download ? displayName : undefined,
  });

  await streamCvFromCloudinary(downloadUrl, res, {
    contentType: career.cvType || 'application/octet-stream',
    disposition: download ? 'attachment' : 'inline',
    filename: displayName,
  });
}

// multer-storage-cloudinary sets `filename` = public_id and `path` = secure_url
function getCvFileMeta(uploaded, req) {
  const originalFileName =
    req.cvUploadMeta?.originalFileName || uploaded.originalname || 'cv';
  const updatedFileName =
    req.cvUploadMeta?.updatedFileName || uploaded.originalname || 'cv';
  const cvPublicId = uploaded.filename || uploaded.public_id;

  return { originalFileName, updatedFileName, cvPublicId };
}

// 1. Create career application - POST /api/career
const createCareer = async (req, res) => {
  try {
    const { name, email, phone, position } = req.body;
    const uploaded = req.file;

    if (
      !name ||
      !email ||
      !phone ||
      !position
    ) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, email, phone, and position',
      });
    }

    if (!uploaded) {
      return res.status(400).json({
        success: false,
        message: "Please upload your CV file using form-data key 'cv'",
      });
    }

    const { originalFileName, updatedFileName, cvPublicId } = getCvFileMeta(uploaded, req);

    if (!cvPublicId) {
      return res.status(400).json({
        success: false,
        message: 'CV upload failed. Please try again.',
      });
    }

    const career = await Career.create({
      name,
      email,
      phone,
      position,
      cvUrl: 'pending',
      cvPublicId,
      cvOriginalFileName: originalFileName,
      cvUpdatedFileName: updatedFileName,
      cvFileName: originalFileName,
      cvType: uploaded.mimetype,
      cvSize: uploaded.size,
    });

    career.cvUrl = buildCvViewUrl(req, career._id);
    await career.save();

    try {
      await sendToZapier({
        name: career.name,
        email: career.email,
        phone: career.phone,
        position: career.position,
        cvUrl: career.cvUrl,
        cvFileName: career.cvFileName,
        cvType: career.cvType,
        cvSize: career.cvSize,
        source: ZAPIER_SOURCES.CAREERS,
      });
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after career save:', zapierError.message);
    }

    try {
      await sendCareerToGoogleSheet({
        name: career.name,
        email: career.email,
        phone: career.phone,
        position: career.position,
        cvOriginalFileName: career.cvOriginalFileName,
        cvUrl: career.cvUrl,
      });
    } catch (sheetsError) {
      console.error('[Google Sheets] Unexpected error after career save:', sheetsError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Career application created successfully',
      data: {
        ...career.toObject(),
        cvDownloadUrl: buildCvDownloadUrl(req, career._id),
        source: ZAPIER_SOURCES.CAREERS,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all career applications - GET /api/career
const getAllCareers = async (req, res) => {
  try {
    const careers = await Career.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: careers.length,
      data: careers,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get career application by id - GET /api/career/:id
const getCareerById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid career application id',
      });
    }

    const career = await Career.findById(id);
    if (!career) {
      return res.status(404).json({
        success: false,
        message: 'Career application not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: career,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Update career application - PUT /api/career/:id
const updateCareer = async (req, res) => {
  try {
    const { id } = req.params;
    const uploaded = req.file;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid career application id',
      });
    }

    const updates = {};
    const allowedFields = [
      'name',
      'email',
      'phone',
      'position',
    ];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    if (uploaded) {
      const { originalFileName, updatedFileName, cvPublicId } = getCvFileMeta(uploaded, req);

      if (!cvPublicId) {
        return res.status(400).json({
          success: false,
          message: 'CV upload failed. Please try again.',
        });
      }

      updates.cvPublicId = cvPublicId;
      updates.cvOriginalFileName = originalFileName;
      updates.cvUpdatedFileName = updatedFileName;
      updates.cvFileName = originalFileName;
      updates.cvType = uploaded.mimetype;
      updates.cvSize = uploaded.size;
    }

    const updated = await Career.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Career application not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Career application updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete career application - DELETE /api/career/:id
const deleteCareer = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid career application id',
      });
    }

    const deleted = await Career.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Career application not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Career application deleted successfully',
      data: deleted,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 6. View CV inline - GET /api/career/:id/cv/view
const viewCareerCv = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid career application id',
      });
    }

    const career = await Career.findById(id);
    if (!career) {
      return res.status(404).json({
        success: false,
        message: 'Career application not found',
      });
    }

    if (!career.cvPublicId) {
      return res.status(404).json({
        success: false,
        message: 'CV not found for this application',
      });
    }

    await streamCareerCv(career, res, { download: false });
  } catch (error) {
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Server error',
      });
    }
  }
};

// 7. Download CV - GET /api/career/:id/cv/download
const downloadCareerCv = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid career application id',
      });
    }

    const career = await Career.findById(id);
    if (!career) {
      return res.status(404).json({
        success: false,
        message: 'Career application not found',
      });
    }

    if (!career.cvPublicId) {
      return res.status(404).json({
        success: false,
        message: 'CV not found for this application',
      });
    }

    await streamCareerCv(career, res, { download: true });
  } catch (error) {
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Server error',
      });
    }
  }
};

module.exports = {
  createCareer,
  getAllCareers,
  getCareerById,
  updateCareer,
  deleteCareer,
  viewCareerCv,
  downloadCareerCv,
};
