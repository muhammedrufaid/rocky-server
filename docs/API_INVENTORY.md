# API Inventory

This document lists the API endpoints currently defined in the server, based on the route mounts in `src/index.js` and the route definitions in `src/routes/*`.

## Total APIs

**26 endpoints**

## Health

- **GET** `/` - Health check

## Auth (`/api/auth`)

- **POST** `/api/auth/signup` - Signup
- **POST** `/api/auth/login` - Login
- **GET** `/api/auth/users` - Get all users (protected)

## Frontend Properties (`/api/frontend`)

- **GET** `/api/frontend/properties` - Get all properties
- **GET** `/api/frontend/properties/search` - Search properties (suggestions)
- **GET** `/api/frontend/properties/search-by-area` - Search properties by area (suggestions)
- **GET** `/api/frontend/properties/types` - Get unique property types
- **GET** `/api/frontend/properties/types-by-category` - Get unique property types by category
- **GET** `/api/frontend/properties/off-plan` - Get off-plan properties
- **GET** `/api/frontend/properties/ready` - Get ready properties
- **GET** `/api/frontend/properties/buy` - Get buy properties
- **GET** `/api/frontend/properties/rent` - Get rent properties
- **GET** `/api/frontend/properties/:propertyRefNo` - Get property by reference number

## Salesforce Migration (`/api/salesforce`)

- **POST** `/api/salesforce/migrate` - Fetch XML feed and upsert to MongoDB
- **POST** `/api/salesforce/migrate-xml` - Post raw XML and upsert to MongoDB

## Contact (`/api/contact`)

- **POST** `/api/contact` - Create contact
- **GET** `/api/contact` - Get all contacts
- **GET** `/api/contact/:id` - Get contact by id
- **PUT** `/api/contact/:id` - Update contact
- **DELETE** `/api/contact/:id` - Delete contact

## Sell Inquiries (`/api/sell`)

- **POST** `/api/sell` - Create sell inquiry
- **GET** `/api/sell` - Get all sell inquiries
- **GET** `/api/sell/:id` - Get sell inquiry by id
- **PUT** `/api/sell/:id` - Update sell inquiry
- **DELETE** `/api/sell/:id` - Delete sell inquiry

