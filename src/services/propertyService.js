require('dotenv').config();
const { XMLParser } = require('fast-xml-parser');
const { extractText, toArray, deduplicate } = require('../utils/xmlUtils');

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

/**
 * Fetches properties from Salesforce XML feed and returns transformed JSON
 */
const fetchAndTransformProperties = async () => {
    const baseUrl = process.env.BASE_URL_SALESFORCE;
    if (!baseUrl) {
        throw new Error('BASE_URL_SALESFORCE is not configured in .env');
    }

    const response = await fetch(baseUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch from Salesforce: ${response.status} ${response.statusText}`);
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
        return { properties: [], total: 0 };
    }

    const rawProperties = toArray(propertiesRoot.Property);
    const properties = rawProperties.map(transformProperty).filter(Boolean);

    return {
        properties,
        total: properties.length
    };
};

module.exports = {
    fetchAndTransformProperties,
    transformProperty
};
