# PubMed Explorer Backend

A Node.js backend for the PubMed Explorer application that interfaces with the PubMed API and stores search results in a SQLite database.

## Features

- RESTful API for searching PubMed articles
- SQLite database for storing search history and results
- Extracts non-academic authors and company affiliations from articles
- API key integration with PubMed API
- Uses native Node.js fetch for API requests

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Start the server:
   ```
   npm start
   ```

   For development with auto-reload:
   ```
   npm run dev
   ```

## API Endpoints

- `POST /api/search` - Search PubMed articles
  - Request body: `{ "query": "search term" }`
  - Returns search results matching the frontend format

- `GET /api/history` - Get recent search history
  - Returns the last 10 searches

- `GET /api/results/:searchId` - Get results for a specific search
  - Returns all results associated with the given search ID

## Database

The backend uses SQLite to store:
- Search queries with timestamps
- Article details including non-academic authors and company affiliations

## PubMed API

The backend uses the NCBI E-utilities API to fetch article data from PubMed.
The API key is configured in the `index.js` file. 