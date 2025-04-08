import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure data directory exists
const dataDir = join(__dirname, 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir);
}

const dbPath = join(dataDir, 'pubmed.db');

// Create database connection
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

// Initialize database tables
function initializeDatabase() {
  db.serialize(() => {
    // Create articles table
    db.run(`CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pmid TEXT UNIQUE,
      title TEXT,
      abstract TEXT,
      authors TEXT,
      journal TEXT,
      publication_date TEXT,
      keywords TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create search_history table
    db.run(`CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT,
      results_count INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  });
}

// Helper function to promisify database operations
function promisifyDbOperation(operation, ...args) {
  return new Promise((resolve, reject) => {
    operation.call(db, ...args, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Database operations
export const dbOperations = {
  // Save article to database
  saveArticle: async (article) => {
    const { pmid, title, abstract, authors, journal, publication_date, keywords } = article;
    const sql = `INSERT OR REPLACE INTO articles (pmid, title, abstract, authors, journal, publication_date, keywords)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;
    
    return promisifyDbOperation(db.run.bind(db), sql, [
      pmid,
      title,
      abstract,
      JSON.stringify(authors),
      journal,
      publication_date,
      JSON.stringify(keywords)
    ]);
  },

  // Get article by PMID
  getArticle: async (pmid) => {
    const sql = 'SELECT * FROM articles WHERE pmid = ?';
    return promisifyDbOperation(db.get.bind(db), sql, [pmid]);
  },

  // Save search query to history
  saveSearch: async (query, resultsCount) => {
    const sql = 'INSERT INTO search_history (query, results_count) VALUES (?, ?)';
    return promisifyDbOperation(db.run.bind(db), sql, [query, resultsCount]);
  },

  // Get search history
  getSearchHistory: async () => {
    const sql = 'SELECT * FROM search_history ORDER BY created_at DESC LIMIT 10';
    return promisifyDbOperation(db.all.bind(db), sql);
  }
};

export default db; 