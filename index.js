import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import fetch from 'node-fetch';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 8081;

// API Key
const API_KEY = '42b4d83e94feb0eaef0ca155fa12a3360709';

// Middleware
app.use(cors());
app.use(express.json());

// Database setup
const dbPath = path.join(__dirname, 'pubmed.db');
const db = new sqlite3.Database(dbPath);

// Convert db methods to promises
// Use a workaround for promisify with ESM modules
const dbRunAsync = (sql, params) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

const dbAllAsync = (sql, params) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      resolve(rows);
    });
  });
};

const dbGetAsync = (sql, params) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      resolve(row);
    });
  });
};

// Create tables if they don't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER,
      pubmed_id TEXT NOT NULL,
      title TEXT NOT NULL,
      publication_date TEXT,
      non_academic_authors TEXT,
      company_affiliations TEXT,
      corresponding_author_email TEXT,
      FOREIGN KEY (search_id) REFERENCES searches(id)
    )
  `);
});

// Helper function to extract non-academic authors and their affiliations
function extractAuthorsAndAffiliations(authors) {
  const nonAcademicAuthors = [];
  const companyAffiliations = [];
  let correspondingAuthorEmail = '';

  // Check if authors exist in the expected format
  if (authors && Array.isArray(authors)) {
    console.log('Authors array:', JSON.stringify(authors, null, 2));
    
    authors.forEach(author => {
      // Extract author name - handle different possible formats
      let authorName = '';
      if (author.name) {
        authorName = author.name;
      } else if (author.fullname) {
        authorName = author.fullname;
      } else if (author.lastname && author.firstname) {
        authorName = `${author.firstname} ${author.lastname}`;
      }
      
      // Extract affiliations - handle different possible formats
      let affiliations = [];
      if (author.affiliation) {
        // Single affiliation string
        affiliations.push(author.affiliation);
      } else if (author.affiliations && Array.isArray(author.affiliations)) {
        // Array of affiliations
        affiliations = author.affiliations.map(aff => 
          typeof aff === 'string' ? aff : (aff.name || aff.affiliation || '')
        );
      }
      
      // Extract from formatted author object (handle PubMed E-utils specific format)
      if (!affiliations.length && author.AffiliationInfo && Array.isArray(author.AffiliationInfo)) {
        affiliations = author.AffiliationInfo.map(aff => aff.Affiliation || '');
      }
      
      // Check each affiliation for non-academic keywords
      if (affiliations.length > 0) {
        affiliations.forEach(affiliation => {
          if (affiliation) {
            const affiliationLower = affiliation.toLowerCase();
            const academicKeywords = [
              'university', 'college', 'institute', 'hospital', 'school', 
              'medical center', 'clinic', 'academy', 'faculty', 'laboratory',
              'department of', 'division of', 'center for', 'national', 'federal'
            ];
            
            // Check if it's a non-academic affiliation
            const isNonAcademic = !academicKeywords.some(keyword => affiliationLower.includes(keyword));
            
            if (isNonAcademic) {
              if (authorName && !nonAcademicAuthors.includes(authorName)) {
                nonAcademicAuthors.push(authorName);
              }
              if (!companyAffiliations.includes(affiliation)) {
                companyAffiliations.push(affiliation);
              }
            }
          }
        });
      }
      
      // Extract corresponding author email
      if (author.email) {
        correspondingAuthorEmail = author.email;
      } else if (author.EmailList && Array.isArray(author.EmailList) && author.EmailList.length > 0) {
        correspondingAuthorEmail = author.EmailList[0];
      }
    });
  } else {
    console.log('No valid authors array found in article data');
  }

  // Use placeholder text only when truly empty
  return {
    nonAcademicAuthors: nonAcademicAuthors.length > 0 ? nonAcademicAuthors : [],
    companyAffiliations: companyAffiliations.length > 0 ? companyAffiliations : [],
    correspondingAuthorEmail: correspondingAuthorEmail || ''
  };
}

// Function to fetch data from PubMed API using native fetch
async function fetchPubMedData(query) {
  try {
    // First, search for article IDs
    const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
    searchUrl.searchParams.append('db', 'pubmed');
    searchUrl.searchParams.append('term', query);
    searchUrl.searchParams.append('retmode', 'json');
    searchUrl.searchParams.append('retmax', '10'); // Limit to 10 results
    searchUrl.searchParams.append('api_key', API_KEY);

    console.log('Fetching from searchUrl:', searchUrl.toString());
    const searchResponse = await fetch(searchUrl);
    
    if (!searchResponse.ok) {
      throw new Error(`Search API error: ${searchResponse.status}`);
    }
    
    const searchData = await searchResponse.json();
    console.log('Search API response:', JSON.stringify(searchData, null, 2));
    const pubmedIds = searchData.esearchresult.idlist;

    if (!pubmedIds || pubmedIds.length === 0) {
      return { results: [] };
    }

    // Process each article individually to get detailed data
    const results = [];
    
    for (const id of pubmedIds) {
      try {
        // Fetch detailed article data with efetch
        const efetchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi');
        efetchUrl.searchParams.append('db', 'pubmed');
        efetchUrl.searchParams.append('id', id);
        efetchUrl.searchParams.append('retmode', 'xml');
        efetchUrl.searchParams.append('api_key', API_KEY);
        
        console.log(`Fetching detailed data for article ${id}:`, efetchUrl.toString());
        const articleResponse = await fetch(efetchUrl);
        
        if (!articleResponse.ok) {
          console.error(`Error fetching details for article ${id}: ${articleResponse.status}`);
          continue;
        }
        
        const articleXml = await articleResponse.text();
        
        // Extract data from XML
        // Since we're working with XML here, we'll do a simple text-based extraction
        const title = extractFromXml(articleXml, '<ArticleTitle>', '</ArticleTitle>') || 'No title available';
        const publicationDate = extractPublicationDate(articleXml) || 'Unknown date';
        
        // Get affiliations
        const affiliationsList = extractAllAffiliations(articleXml);
        
        // Define academic keywords
        const academicKeywords = [
          'university', 'college', 'institute', 'hospital', 'school', 
          'medical center', 'clinic', 'academy', 'faculty', 'laboratory',
          'department of', 'division of', 'center for', 'national', 'federal'
        ];
        
        // Filter non-academic affiliations
        const nonAcademicAffiliations = affiliationsList.filter(aff => {
          const affLower = aff.toLowerCase();
          return !academicKeywords.some(keyword => affLower.includes(keyword));
        });
        
        // Get authors with non-academic affiliations
        const nonAcademicAuthors = extractAuthorsWithNonAcademicAffiliations(articleXml, academicKeywords);
        
        // Get corresponding author email
        const email = extractEmail(articleXml) || '';
        
        results.push({
          pubmedId: id,
          title,
          publicationDate,
          nonAcademicAuthors: nonAcademicAuthors.length > 0 ? nonAcademicAuthors : [],
          companyAffiliations: nonAcademicAffiliations.length > 0 ? nonAcademicAffiliations : [],
          correspondingAuthorEmail: email,
          url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`
        });
      } catch (error) {
        console.error(`Error processing article ${id}:`, error);
      }
    }

    console.log('Processed results:', JSON.stringify(results, null, 2));
    return { results };
  } catch (error) {
    console.error('Error fetching from PubMed API:', error);
    throw new Error('Failed to fetch data from PubMed API');
  }
}

// Helper function to extract text between XML tags
function extractFromXml(xml, startTag, endTag) {
  const startIdx = xml.indexOf(startTag);
  if (startIdx === -1) return '';
  
  const contentStart = startIdx + startTag.length;
  const endIdx = xml.indexOf(endTag, contentStart);
  if (endIdx === -1) return '';
  
  return xml.substring(contentStart, endIdx).trim();
}

// Extract all affiliations from XML
function extractAllAffiliations(xml) {
  const affiliations = [];
  
  // Look for standard Affiliation tags
  let affStart = 0;
  while (true) {
    affStart = xml.indexOf('<Affiliation>', affStart);
    if (affStart === -1) break;
    
    const contentStart = affStart + '<Affiliation>'.length;
    const affEnd = xml.indexOf('</Affiliation>', contentStart);
    if (affEnd === -1) break;
    
    const affiliation = xml.substring(contentStart, affEnd).trim();
    if (affiliation && !affiliations.includes(affiliation)) {
      affiliations.push(affiliation);
    }
    
    affStart = affEnd;
  }
  
  // Look for AffiliationInfo tags
  affStart = 0;
  while (true) {
    affStart = xml.indexOf('<AffiliationInfo>', affStart);
    if (affStart === -1) break;
    
    const endAffInfo = xml.indexOf('</AffiliationInfo>', affStart);
    if (endAffInfo === -1) break;
    
    const affSection = xml.substring(affStart, endAffInfo);
    const affContent = extractFromXml(affSection, '<Affiliation>', '</Affiliation>');
    
    if (affContent && !affiliations.includes(affContent)) {
      affiliations.push(affContent);
    }
    
    affStart = endAffInfo;
  }
  
  return affiliations;
}

// Extract authors with non-academic affiliations
function extractAuthorsWithNonAcademicAffiliations(xml, academicKeywords) {
  const authors = [];
  const authorSection = xml.indexOf('<AuthorList');
  const authorSectionEnd = xml.indexOf('</AuthorList>', authorSection);
  
  if (authorSection === -1 || authorSectionEnd === -1) {
    return authors;
  }
  
  const authorListXml = xml.substring(authorSection, authorSectionEnd);
  
  // Find each Author section
  let authorStart = 0;
  while (true) {
    authorStart = authorListXml.indexOf('<Author', authorStart);
    if (authorStart === -1) break;
    
    const authorEnd = authorListXml.indexOf('</Author>', authorStart);
    if (authorEnd === -1) break;
    
    const authorXml = authorListXml.substring(authorStart, authorEnd);
    
    // Extract author name
    const lastName = extractFromXml(authorXml, '<LastName>', '</LastName>');
    const foreName = extractFromXml(authorXml, '<ForeName>', '</ForeName>');
    
    let authorName = '';
    if (lastName && foreName) {
      authorName = `${foreName} ${lastName}`;
    } else if (lastName) {
      authorName = lastName;
    } else if (extractFromXml(authorXml, '<CollectiveName>', '</CollectiveName>')) {
      authorName = extractFromXml(authorXml, '<CollectiveName>', '</CollectiveName>');
    }
    
    if (!authorName) {
      authorStart = authorEnd;
      continue;
    }
    
    // Check author's affiliations
    const authorAffiliations = [];
    let affStart = 0;
    
    while (true) {
      affStart = authorXml.indexOf('<AffiliationInfo>', affStart);
      if (affStart === -1) break;
      
      const endAffInfo = authorXml.indexOf('</AffiliationInfo>', affStart);
      if (endAffInfo === -1) break;
      
      const affSection = authorXml.substring(affStart, endAffInfo);
      const affContent = extractFromXml(affSection, '<Affiliation>', '</Affiliation>');
      
      if (affContent) {
        authorAffiliations.push(affContent);
      }
      
      affStart = endAffInfo;
    }
    
    // If no specific affiliations found, look for direct Affiliation tag
    if (authorAffiliations.length === 0) {
      const affiliation = extractFromXml(authorXml, '<Affiliation>', '</Affiliation>');
      if (affiliation) {
        authorAffiliations.push(affiliation);
      }
    }
    
    // Check if author has non-academic affiliation
    const hasNonAcademicAffiliation = authorAffiliations.some(aff => {
      const affLower = aff.toLowerCase();
      return !academicKeywords.some(keyword => affLower.includes(keyword));
    });
    
    if (hasNonAcademicAffiliation) {
      authors.push(authorName);
    }
    
    authorStart = authorEnd;
  }
  
  return authors;
}

// Extract publication date
function extractPublicationDate(xml) {
  // Try to find PubDate in different formats
  const pubDateSection = xml.indexOf('<PubDate>');
  const pubDateEndSection = xml.indexOf('</PubDate>', pubDateSection);
  
  if (pubDateSection === -1 || pubDateEndSection === -1) {
    return 'Unknown date';
  }
  
  const pubDateXml = xml.substring(pubDateSection, pubDateEndSection);
  
  // Try different date formats
  const year = extractFromXml(pubDateXml, '<Year>', '</Year>');
  const month = extractFromXml(pubDateXml, '<Month>', '</Month>');
  const day = extractFromXml(pubDateXml, '<Day>', '</Day>');
  
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  } else if (year && month) {
    return `${year}-${month}`;
  } else if (year) {
    return year;
  } else {
    // Try MedlineDate format
    const medlineDate = extractFromXml(pubDateXml, '<MedlineDate>', '</MedlineDate>');
    if (medlineDate) {
      return medlineDate;
    }
  }
  
  return 'Unknown date';
}

// Extract email from XML
function extractEmail(xml) {
  // Check if there's a specific corresponding author section
  let email = '';
  
  // Try to find email in ELocationID
  let emailStart = 0;
  while (true) {
    emailStart = xml.indexOf('<ELocationID EIdType="email"', emailStart);
    if (emailStart === -1) break;
    
    const emailTagEnd = xml.indexOf('</ELocationID>', emailStart);
    if (emailTagEnd === -1) break;
    
    const emailTag = xml.substring(emailStart, emailTagEnd);
    const emailContent = emailTag.substring(emailTag.indexOf('>') + 1);
    
    if (emailContent && emailContent.includes('@')) {
      email = emailContent.trim();
      break;
    }
    
    emailStart = emailTagEnd;
  }
  
  // If no email found, try to extract from author information
  if (!email) {
    // Looking for email pattern in author information
    const emailMatch = xml.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
    if (emailMatch && emailMatch[0]) {
      email = emailMatch[0];
    }
  }
  
  return email;
}

// API endpoint for search
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query || query.trim() === '') {
      return res.status(400).json({ error: 'Search query is required' });
    }

    // Log search query to database
    const searchResult = await dbRunAsync(
      'INSERT INTO searches (query) VALUES (?)',
      [query]
    );
    
    const searchId = searchResult.lastID;
    
    // Fetch data from PubMed API
    const data = await fetchPubMedData(query);
    
    // Store results in database
    if (data.results && data.results.length > 0) {
      for (const result of data.results) {
        await dbRunAsync(
          'INSERT INTO results (search_id, pubmed_id, title, publication_date, non_academic_authors, company_affiliations, corresponding_author_email) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            searchId,
            result.pubmedId,
            result.title,
            result.publicationDate,
            JSON.stringify(result.nonAcademicAuthors),
            JSON.stringify(result.companyAffiliations),
            result.correspondingAuthorEmail
          ]
        );
      }
    }

    res.json(data);
  } catch (error) {
    console.error('Error handling search request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to get search history
app.get('/api/history', async (req, res) => {
  try {
    const searches = await dbAllAsync('SELECT * FROM searches ORDER BY timestamp DESC LIMIT 10');
    res.json({ searches });
  } catch (error) {
    console.error('Error fetching search history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to get results for a specific search
app.get('/api/results/:searchId', async (req, res) => {
  try {
    const { searchId } = req.params;
    
    const results = await dbAllAsync(
      'SELECT * FROM results WHERE search_id = ?',
      [searchId]
    );
    
    // Convert stored JSON strings back to arrays
    const formattedResults = results.map(result => ({
      ...result,
      non_academic_authors: JSON.parse(result.non_academic_authors),
      company_affiliations: JSON.parse(result.company_affiliations)
    }));
    
    res.json({ results: formattedResults });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 