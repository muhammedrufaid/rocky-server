require('dotenv').config();
const { XMLParser } = require('fast-xml-parser');

/**
 * Extracts text value from parsed XML node (handles CDATA, plain text, and primitives)
 * Note: fast-xml-parser with parseTagValue converts numeric strings to numbers
 */
const extractText = (node) => {
    if (node == null || node === undefined) return null;
    if (typeof node === 'string') return node.trim();
    if (typeof node === 'number' || typeof node === 'boolean') return String(node);
    if (typeof node === 'object' && node['#text'] !== undefined) return String(node['#text']).trim();
    if (typeof node === 'object' && node['#cdata-section'] !== undefined) return String(node['#cdata-section']).trim();
    return null;
};

/**
 * Ensures value is always an array (handles single vs multiple elements)
 */
const toArray = (value) => {
    if (value == null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    return [value];
};

/**
 * Removes duplicates from array while preserving order (first occurrence wins)
 */
const deduplicate = (arr) => [...new Set(arr)];

/**
 * Transforms a raw XML Property node to a clean JSON property object
 * Deduplicates features, portals, and images to match XML source without duplicates
 */
const transformProperty = (prop) => {
    if (!prop) return null;

    const features = deduplicate(toArray(prop.Features?.Feature).map((f) => extractText(f)).filter(Boolean));
    const portals = deduplicate(toArray(prop.portals?.portal).map((p) => extractText(p)).filter(Boolean));
    const images = deduplicate(toArray(prop.Images?.Image).map((i) => extractText(i)).filter(Boolean));

    return {
        propertyRefNo: extractText(prop.Property_Ref_No),
        permitNumber: extractText(prop.Permit_Number),
        propertyStatus: extractText(prop.Property_Status),
        propertyPurpose: extractText(prop.Property_purpose),
        propertyType: extractText(prop.Property_Type),
        propertySize: extractText(prop.Property_Size),
        propertySizeUnit: extractText(prop.Property_Size_Unit),
        bedrooms: extractText(prop.Bedrooms),
        bathrooms: extractText(prop.Bathrooms),
        offPlan: extractText(prop.Off_plan),
        lastUpdated: extractText(prop.Last_Updated),
        city: extractText(prop.City),
        locality: extractText(prop.Locality),
        subLocality: extractText(prop.Sub_Locality),
        towerName: extractText(prop.Tower_Name),
        propertyTitle: extractText(prop.Property_Title),
        propertyDescription: extractText(prop.Property_Description),
        price: extractText(prop.Price),
        furnished: extractText(prop.Furnished),
        rentFrequency: extractText(prop.Rent_Frequency),
        listingAgentEmail: extractText(prop.Listing_Agent_Email),
        listingAgent: extractText(prop.Listing_Agent),
        listingAgentPhone: extractText(prop.Listing_Agent_Phone),
        features,
        portals,
        images
    };
};

const getAllProperties = async (req, res) => {
    try {
        const baseUrl = process.env.BASE_URL_SALESFORCE;
        if (!baseUrl) {
            return res.status(500).json({ message: 'BASE_URL_SALESFORCE is not configured in .env' });
        }

        const response = await fetch(baseUrl);
        if (!response.ok) {
            return res.status(response.status).json({
                message: `Failed to fetch from Salesforce: ${response.status} ${response.statusText}`
            });
        }

        const xmlText = await response.text();
        const parser = new XMLParser({
            ignoreAttributes: false,
            trimValues: true,
            parseTagValue: false,
            parseAttributeValue: false
        });

        const parsed = parser.parse(xmlText);
        const propertiesRoot = parsed?.Properties;

        if (!propertiesRoot) {
            return res.status(200).json({ properties: [] });
        }

        const rawProperties = toArray(propertiesRoot.Property);
        const properties = rawProperties.map(transformProperty).filter(Boolean);

        res.status(200).json({
            properties,
            total: properties.length
        });
    } catch (error) {
        console.error('getAllProperties error:', error);
        res.status(500).json({
            message: error.message || 'Failed to fetch and transform properties'
        });
    }
};

module.exports = {
    getAllProperties
};
