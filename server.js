const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('./database/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Body Parsers & Static Files
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// View Engine (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session Management
app.use(session({
  secret: 'securebank_2018_lab_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

const os = require('os');
const isVercel = !!process.env.VERCEL;
const uploadDir = isVercel
  ? path.join(os.tmpdir(), 'uploads')
  : path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    if (req.session && req.session.isSecureMode) {
      // SECURE MODE: Randomized filename with safe extension
      const ext = path.extname(file.originalname).toLowerCase();
      const safeName = crypto.randomBytes(16).toString('hex') + ext;
      cb(null, safeName);
    } else {
      // ATTACK MODE: Preserve original filename (Vulnerable to path/extension manipulation)
      cb(null, file.originalname);
    }
  }
});
const upload = multer({ storage });

// Initialize Global Session & Telemetry Middleware
app.use((req, res, next) => {
  if (req.session.isSecureMode === undefined) {
    req.session.isSecureMode = false; // Default to Attack Mode
  }
  if (!req.session.session_id) {
    req.session.session_id = crypto.randomBytes(12).toString('hex');
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  if (req.session.failedLoginAttempts === undefined) {
    req.session.failedLoginAttempts = 0;
  }

  // Populate Locals for Views
  res.locals.user = req.session.user || null;
  res.locals.isSecureMode = req.session.isSecureMode;
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

// Telemetry Helper Functions
function recordAttempt(vulnKey, req, isSuccess = false) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  
  db.run(
    `UPDATE telemetry SET attempt_count = attempt_count + 1, last_attempt = ? WHERE vuln_key = ?`,
    [timestamp, vulnKey]
  );

  const sessionId = req.session.session_id;

  // Initialize progress record for session
  db.run(
    `INSERT OR IGNORE INTO session_progress (session_id) VALUES (?)`,
    [sessionId],
    () => {
      if (isSuccess) {
        db.run(`UPDATE telemetry SET solve_count = solve_count + 1 WHERE vuln_key = ?`, [vulnKey]);
        db.run(`UPDATE session_progress SET ${vulnKey} = 1 WHERE session_id = ?`, [sessionId], () => {
          checkCompletion(sessionId);
        });
      }
    }
  );
}

function checkCompletion(sessionId) {
  db.get(
    `SELECT * FROM session_progress WHERE session_id = ?`,
    [sessionId],
    (err, row) => {
      if (row && row.sqli && row.xss && row.idor && row.csrf && row.weakauth && row.upload && !row.completed) {
        db.run(`UPDATE session_progress SET completed = 1 WHERE session_id = ?`, [sessionId]);
        db.run(`INSERT OR IGNORE INTO completed_labs (session_id) VALUES (?)`, [sessionId]);
      }
    }
  );
}

function getEndpoint(vulnKey) {
  const endpoints = {
    sqli: '/login (POST)',
    xss: '/profile/update (POST)',
    idor: '/transaction?id=... (GET)',
    csrf: '/transfer (POST)',
    weakauth: '/login (POST)',
    upload: '/profile/upload (POST)'
  };
  return endpoints[vulnKey] || '/';
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// Toggle Attack / Secure Mode
app.get('/toggle-mode', (req, res) => {
  req.session.isSecureMode = !req.session.isSecureMode;
  let target = req.get('Referrer') || '/';
  target = target.replace(/\/profile\/(update|upload)$/, '/profile');
  res.redirect(target);
});

// Fallback GET routes for form actions
app.get('/profile/update', (req, res) => res.redirect('/profile'));
app.get('/profile/upload', (req, res) => res.redirect('/profile'));

// Interactive Presentation Route
app.get('/presentation', (req, res) => {
  res.render('presentation');
});

// PPTX Download Route
app.get('/SecureBank_Pro_Presentation.pptx', (req, res) => {
  res.download(path.join(__dirname, 'SecureBank_Pro_Presentation.pptx'));
});

// Home Page (Lab Stats & Counter Dashboard)
app.get('/', (req, res) => {
  const sessionId = req.session.session_id;

  db.all(`SELECT * FROM telemetry`, [], (err, telemetryRows) => {
    db.get(`SELECT COUNT(DISTINCT session_id) as totalSessions FROM session_progress`, [], (err, r1) => {
      db.get(`SELECT COUNT(*) as solvedAllSix FROM completed_labs`, [], (err, r2) => {
        db.get(`SELECT SUM(attempt_count) as totalAttempts FROM telemetry`, [], (err, r3) => {
          db.get(`SELECT * FROM session_progress WHERE session_id = ?`, [sessionId], (err, userProgress) => {

            const stats = {
              totalSessions: (r1 && r1.totalSessions) || 1,
              solvedAllSix: (r2 && r2.solvedAllSix) || 0,
              totalAttempts: (r3 && r3.totalAttempts) || 0
            };

            res.render('index', {
              telemetry: telemetryRows || [],
              stats: stats,
              userProgress: userProgress || {},
              getEndpoint: getEndpoint
            });
          });
        });
      });
    });
  });
});

// Login Page (GET)
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null, info: null });
});

// Login POST - Demonstrating SQL Injection & Weak Auth
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  // Track Auth Telemetry Attempt
  recordAttempt('weakauth', req, false);

  if (req.session.isSecureMode) {
    // ---------------------------------------------------------
    // SECURE MODE: Account lockout + Parameterized Query
    // ---------------------------------------------------------
    if (req.session.failedLoginAttempts >= 5) {
      return res.render('login', {
        error: 'Account temporarily locked due to repeated failed login attempts. Try again later.',
        info: null
      });
    }

    db.get(
      `SELECT * FROM users WHERE username = ? AND password = ?`,
      [username, password],
      (err, row) => {
        if (err || !row) {
          req.session.failedLoginAttempts += 1;
          return res.render('login', {
            error: `Invalid credentials. Attempt ${req.session.failedLoginAttempts}/5`,
            info: null
          });
        }
        req.session.failedLoginAttempts = 0;
        req.session.user = row;
        res.redirect('/dashboard');
      }
    );
  } else {
    // ---------------------------------------------------------
    // ATTACK MODE: SQL Injection (Unsanitized Concatenation) + Default Auth
    // ---------------------------------------------------------
    const isSqlInjectionPattern = /'|\bOR\b|\bUNION\b|--|#/i.test(username) || /'|\bOR\b|\bUNION\b|--|#/i.test(password);

    if (username === 'admin' && password === 'admin') {
      recordAttempt('weakauth', req, true);
    }

    const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;

    db.all(query, (err, rows) => {
      if (err) {
        // Syntax error triggered: Record attempt only (solve = false)
        recordAttempt('sqli', req, false);
        return res.render('login', {
          error: `Database Error: ${err.message}. Raw Query: [${query}]`,
          info: null
        });
      }

      if (rows && rows.length > 0) {
        if (isSqlInjectionPattern || rows.length > 1) {
          // Successful authentication bypass via SQL Injection
          recordAttempt('sqli', req, true);
        }
        req.session.user = rows[0];
        return res.redirect('/dashboard');
      } else {
        if (isSqlInjectionPattern) {
          recordAttempt('sqli', req, false);
        }
        return res.render('login', { error: 'Invalid username or password.', info: null });
      }
    });
  }
});

// Dashboard View
app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const userId = req.session.user.id;
  db.all(
    `SELECT * FROM transactions WHERE sender_id = ? OR receiver_id = ? ORDER BY id DESC LIMIT 5`,
    [userId, userId],
    (err, rows) => {
      res.render('dashboard', { transactions: rows || [] });
    }
  );
});

// Profile Management Page
app.get('/profile', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  // Refetch user data to ensure up-to-date bio and avatar
  db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, row) => {
    req.session.user = row;
    res.render('profile', { message: null, error: null });
  });
});

// Profile Update (Stored XSS Demo)
app.post('/profile/update', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { full_name, email, about_me } = req.body;
  const userId = req.session.user.id;

  const containsScript = /<[a-z0-9]+/i.test(about_me) || /<script|<iframe|javascript:|on\w+=/i.test(about_me);
  if (containsScript) {
    if (!req.session.isSecureMode) {
      recordAttempt('xss', req, true);
    } else {
      recordAttempt('xss', req, false);
    }
  } else {
    recordAttempt('xss', req, false);
  }

  db.run(
    `UPDATE users SET full_name = ?, email = ?, about_me = ? WHERE id = ?`,
    [full_name, email, about_me, userId],
    (err) => {
      db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, updatedUser) => {
        req.session.user = updatedUser;
        res.render('profile', {
          message: 'Profile updated successfully.',
          error: null
        });
      });
    }
  );
});

// Profile Picture Upload (File Upload Vulnerability Demo)
app.post('/profile/upload', upload.single('profile_pic'), (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  if (!req.file) {
    return res.render('profile', { message: null, error: 'Please select a file to upload.' });
  }

  const filename = req.file.filename;
  const originalExt = path.extname(req.file.originalname).toLowerCase();
  const allowedExts = ['.png', '.jpg', '.jpeg', '.gif'];

  if (req.session.isSecureMode) {
    // SECURE MODE: Strict File Extension & MIME Validation
    if (!allowedExts.includes(originalExt) || !req.file.mimetype.startsWith('image/')) {
      // Remove invalid uploaded file
      fs.unlinkSync(req.file.path);
      return res.render('profile', {
        message: null,
        error: 'Security Error: Only image files (.jpg, .png, .gif) are permitted.'
      });
    }
  } else {
    // ATTACK MODE: Unvalidated File Upload
    const isDangerousUpload = !allowedExts.includes(originalExt);
    if (isDangerousUpload) {
      recordAttempt('upload', req, true);
    } else {
      recordAttempt('upload', req, false);
    }
  }

  // Update user avatar in DB
  db.run(
    `UPDATE users SET profile_pic = ? WHERE id = ?`,
    [filename, req.session.user.id],
    (err) => {
      req.session.user.profile_pic = filename;
      res.render('profile', {
        message: `Profile picture updated to [${filename}].`,
        error: null
      });
    }
  );
});

// Transaction Receipt View (IDOR Demo)
app.get('/transaction', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const txnId = req.query.id;
  const currentUserId = req.session.user.id;

  if (!txnId) return res.redirect('/dashboard');

  if (req.session.isSecureMode) {
    // ---------------------------------------------------------
    // SECURE MODE: Ownership Verification (Prevents IDOR)
    // ---------------------------------------------------------
    db.get(
      `SELECT * FROM transactions WHERE id = ? AND (sender_id = ? OR receiver_id = ?)`,
      [txnId, currentUserId, currentUserId],
      (err, row) => {
        if (err || !row) {
          recordAttempt('idor', req, false);
          return res.status(403).render('transactions', {
            transaction: null,
            error: 'Access Denied: You do not have authorization to view this receipt.'
          });
        }
        res.render('transactions', { transaction: row, error: null });
      }
    );
  } else {
    // ---------------------------------------------------------
    // ATTACK MODE: Insecure Direct Object Reference (No Ownership Check)
    // ---------------------------------------------------------
    db.get(`SELECT * FROM transactions WHERE id = ${txnId}`, (err, row) => {
      if (err || !row) {
        return res.render('transactions', { transaction: null, error: 'Transaction record not found.' });
      }

      // Check if user is accessing someone else's transaction
      if (row.sender_id !== currentUserId && row.receiver_id !== currentUserId) {
        recordAttempt('idor', req, true);
      } else {
        recordAttempt('idor', req, false);
      }

      res.render('transactions', { transaction: row, error: null });
    });
  }
});

// Transactions List View
app.get('/transactions', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const currentUserId = req.session.user.id;
  db.all(
    `SELECT * FROM transactions WHERE sender_id = ? OR receiver_id = ? ORDER BY id DESC`,
    [currentUserId, currentUserId],
    (err, rows) => {
      res.render('dashboard', { transactions: rows || [] });
    }
  );
});

// Transfer Money GET
app.get('/transfer', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('transfer', { error: null, success: null });
});

// Transfer Money POST (CSRF Demo)
app.post('/transfer', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { recipient, amount, description, _csrf } = req.body;
  const transferAmount = parseFloat(amount);
  const sender = req.session.user;

  if (req.session.isSecureMode) {
    // ---------------------------------------------------------
    // SECURE MODE: Anti-CSRF Token Validation
    // ---------------------------------------------------------
    if (!_csrf || _csrf !== req.session.csrfToken) {
      return res.status(403).render('transfer', {
        error: 'Security Violation: Invalid or missing anti-CSRF token.',
        success: null
      });
    }
  } else {
    // ---------------------------------------------------------
    // ATTACK MODE: Unprotected CSRF Endpoint
    // ---------------------------------------------------------
    const isCsrfRequest = !_csrf || _csrf !== req.session.csrfToken;
    if (isCsrfRequest) {
      recordAttempt('csrf', req, true);
    } else {
      recordAttempt('csrf', req, false);
    }
  }

  if (isNaN(transferAmount) || transferAmount <= 0) {
    return res.render('transfer', { error: 'Please enter a valid transfer amount.', success: null });
  }

  if (sender.balance < transferAmount) {
    return res.render('transfer', { error: 'Insufficient account balance.', success: null });
  }

  db.get(`SELECT * FROM users WHERE username = ?`, [recipient], (err, recipientUser) => {
    if (!recipientUser) {
      return res.render('transfer', { error: `Recipient username '${recipient}' not found.`, success: null });
    }

    if (recipientUser.id === sender.id) {
      return res.render('transfer', { error: 'Cannot transfer funds to your own account.', success: null });
    }

    // Execute Balance Transfer & Insert Receipt
    db.serialize(() => {
      db.run(`UPDATE users SET balance = balance - ? WHERE id = ?`, [transferAmount, sender.id]);
      db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [transferAmount, recipientUser.id]);
      
      db.run(
        `INSERT INTO transactions (sender_id, receiver_id, sender_name, receiver_name, amount, description) VALUES (?, ?, ?, ?, ?, ?)`,
        [sender.id, recipientUser.id, sender.full_name, recipientUser.full_name, transferAmount, description || 'Wire Transfer'],
        function() {
          sender.balance -= transferAmount;
          req.session.user.balance = sender.balance;

          res.render('transfer', {
            error: null,
            success: `Successfully transferred $${transferAmount.toFixed(2)} to ${recipientUser.full_name}. Receipt ID: #${this.lastID}`
          });
        }
      );
    });
  });
});

// Admin Panel View
app.get('/admin', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') {
    return res.status(403).send('403 Forbidden: Administrator rights required.');
  }

  db.all(`SELECT id, username, full_name, email, role, balance FROM users`, (err, users) => {
    db.all(`SELECT * FROM telemetry`, (err, telemetry) => {
      res.render('admin', { users: users || [], telemetry: telemetry || [] });
    });
  });
});

// Lab Reset Endpoint
app.get('/reset-lab', (req, res) => {
  db.serialize(() => {
    db.run(`UPDATE telemetry SET attempt_count = 0, solve_count = 0, last_attempt = NULL`);
    db.run(`DELETE FROM completed_labs`);
    db.run(`DELETE FROM session_progress`);
    req.session.destroy(() => {
      res.redirect('/');
    });
  });
});

// Logout Route
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Start Express Server / Export for Vercel Serverless
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`  SecureBank Pro Lab Server Running on Port ${PORT}`);
    console.log(`  Access URL: http://localhost:${PORT}`);
    console.log(`  Lab Mode: 2018 Neutral Enterprise Aesthetic`);
    console.log(`=======================================================`);
  });
}

module.exports = app;
