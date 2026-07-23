const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'securebank.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Users Table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      full_name TEXT,
      email TEXT,
      role TEXT DEFAULT 'user',
      about_me TEXT,
      profile_pic TEXT DEFAULT 'default.png',
      balance REAL DEFAULT 1000.00
    )
  `);

  // Transactions Table
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER,
      receiver_id INTEGER,
      sender_name TEXT,
      receiver_name TEXT,
      amount REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      description TEXT
    )
  `);

  // Telemetry Table (Attempt & Solved stats)
  db.run(`
    CREATE TABLE IF NOT EXISTS telemetry (
      vuln_key TEXT PRIMARY KEY,
      name TEXT,
      attempt_count INTEGER DEFAULT 0,
      solve_count INTEGER DEFAULT 0,
      last_attempt DATETIME
    )
  `);

  // Completed Users Tracking (Tracks IP or session hash that completed all 6 vulns)
  db.run(`
    CREATE TABLE IF NOT EXISTS completed_labs (
      session_id TEXT PRIMARY KEY,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Progress per session table
  db.run(`
    CREATE TABLE IF NOT EXISTS session_progress (
      session_id TEXT PRIMARY KEY,
      sqli INTEGER DEFAULT 0,
      xss INTEGER DEFAULT 0,
      idor INTEGER DEFAULT 0,
      csrf INTEGER DEFAULT 0,
      weakauth INTEGER DEFAULT 0,
      upload INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0
    )
  `);

  // Initialize Telemetry Keys
  const vulns = [
    { key: 'sqli', name: 'SQL Injection' },
    { key: 'xss', name: 'Stored Cross-Site Scripting (XSS)' },
    { key: 'idor', name: 'Insecure Direct Object Reference (IDOR)' },
    { key: 'csrf', name: 'Cross-Site Request Forgery (CSRF)' },
    { key: 'weakauth', name: 'Weak Authentication & Credential Abuse' },
    { key: 'upload', name: 'Unvalidated File Upload' }
  ];

  vulns.forEach(v => {
    db.run(
      `INSERT OR IGNORE INTO telemetry (vuln_key, name, attempt_count, solve_count) VALUES (?, ?, 0, 0)`,
      [v.key, v.name]
    );
  });

  // Seed Default Users
  // Standard user: john_doe / Password123
  // Standard user: alice_smith / SecurePass2018
  // Admin user: admin / admin (Weak Auth demo)
  db.run(`INSERT OR IGNORE INTO users (id, username, password, full_name, email, role, about_me, balance) VALUES 
    (1, 'admin', 'admin', 'System Administrator', 'admin@securebankpro.local', 'admin', 'System Administrator account.', 50000.00),
    (2, 'john_doe', 'Password123', 'John Doe', 'john@example.com', 'user', 'Senior Software Engineer. Passionate about cyber security.', 2500.50),
    (3, 'alice_smith', 'AlicePass2018', 'Alice Smith', 'alice@example.com', 'user', 'Financial Analyst and avid reader.', 1840.75)
  `);

  // Seed Default Transactions (IDOR target)
  db.run(`INSERT OR IGNORE INTO transactions (id, sender_id, receiver_id, sender_name, receiver_name, amount, description, timestamp) VALUES
    (101, 1, 2, 'System Administrator', 'John Doe', 500.00, 'Monthly Salary Bonus', '2018-05-12 10:30:00'),
    (102, 2, 3, 'John Doe', 'Alice Smith', 120.00, 'Dinner Expense Split', '2018-05-14 14:20:00'),
    (103, 3, 2, 'Alice Smith', 'John Doe', 45.50, 'Book purchase reimbursement', '2018-05-15 09:15:00'),
    (104, 1, 3, 'System Administrator', 'Alice Smith', 1500.00, 'Confidential Executive Payment', '2018-05-18 16:45:00')
  `);
});

module.exports = db;
