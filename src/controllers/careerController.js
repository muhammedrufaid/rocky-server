const mongoose = require('mongoose');
const Career = require('../models/Career');
const { uploadFile, deleteFile } = require('../services/s3Service');
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');
const { sendCareerToGoogleSheet } = require('../services/googleSheetsService');

function getCvKey(career) {
  return career.cv?.key || null;
}

function buildPublicCvUrl(key) {
  if (!key) return null;
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) return null;

  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

async function uploadCareerCv(file) {
  return uploadFile(file, 'cvs');
}

async function removeCareerCvFromS3(key) {
  if (!key) return;

  try {
    await deleteFile(key);
  } catch (error) {
    console.error('[S3] Failed to delete CV:', error.message);
  }
}

// 1. Create career application - POST /api/career
const createCareer = async (req, res) => {
  let uploadedCv;

  try {
    const { fullName, name, email, phone, position } = req.body;
    const uploaded = req.file;
    const resolvedFullName = fullName ?? name;

    if (!resolvedFullName || !email || !phone || !position) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, email, phone, and position',
      });
    }

    if (!uploaded) {
      return res.status(400).json({
        success: false,
        message: "Please upload your CV file using form-data key 'cv'",
      });
    }

    uploadedCv = await uploadCareerCv(uploaded);

    const career = await Career.create({
      fullName: resolvedFullName,
      email,
      phone,
      position,
      cv: {
        key: uploadedCv.key,
        fileName: uploaded.originalname,
      },
      cvUrl: 'pending',
      cvFileName: uploaded.originalname,
      cvType: uploaded.mimetype,
      cvSize: uploaded.size,
    });

    career.cvUrl = buildPublicCvUrl(career.cv.key);
    await career.save();

    try {
      await sendToZapier({
        fullName: career.fullName,
        email: career.email,
        phone: career.phone,
        position: career.position,
        cvUrl: career.cvUrl,
        cvFileName: career.cv.fileName,
        cvType: career.cvType,
        cvSize: career.cvSize,
        source: ZAPIER_SOURCES.CAREERS,
      });
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after career save:', zapierError.message);
    }

    try {
      await sendCareerToGoogleSheet({
        fullName: career.fullName,
        email: career.email,
        phone: career.phone,
        position: career.position,
        cvOriginalFileName: career.cv.fileName,
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
        cvUrl: buildPublicCvUrl(career.cv?.key),
        source: ZAPIER_SOURCES.CAREERS,
      },
    });
  } catch (error) {
    if (uploadedCv?.key) {
      await removeCareerCvFromS3(uploadedCv.key);
    }

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create career application',
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
      data: careers.map((career) => {
        const obj = career.toObject();
        return {
          ...obj,
          cvUrl: buildPublicCvUrl(obj.cv?.key),
        };
      }),
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
      data: {
        ...career.toObject(),
        cvUrl: buildPublicCvUrl(career.cv?.key),
      },
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
  let uploadedCv;
  let previousCvKey;

  try {
    const { id } = req.params;
    const uploaded = req.file;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid career application id',
      });
    }

    const existingCareer = await Career.findById(id);
    if (!existingCareer) {
      return res.status(404).json({
        success: false,
        message: 'Career application not found',
      });
    }

    const updates = {};
    const allowedFields = ['fullName', 'email', 'phone', 'position'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    if (updates.fullName === undefined && req.body.name !== undefined) {
      updates.fullName = req.body.name;
    }

    if (uploaded) {
      previousCvKey = getCvKey(existingCareer);
      uploadedCv = await uploadCareerCv(uploaded);

      updates.cv = {
        key: uploadedCv.key,
        fileName: uploaded.originalname,
      };
      updates.cvFileName = uploaded.originalname;
      updates.cvType = uploaded.mimetype;
      updates.cvSize = uploaded.size;
      updates.cvUrl = buildPublicCvUrl(uploadedCv.key);
    }

    const updated = await Career.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (uploaded && previousCvKey && previousCvKey !== uploadedCv.key) {
      await removeCareerCvFromS3(previousCvKey);
    }

    return res.status(200).json({
      success: true,
      message: 'Career application updated successfully',
      data: {
        ...updated.toObject(),
        cvUrl: buildPublicCvUrl(updated.cv?.key),
      },
    });
  } catch (error) {
    if (uploadedCv?.key) {
      await removeCareerCvFromS3(uploadedCv.key);
    }

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update career application',
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

    await removeCareerCvFromS3(getCvKey(deleted));

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

module.exports = {
  createCareer,
  getAllCareers,
  getCareerById,
  updateCareer,
  deleteCareer,
};
