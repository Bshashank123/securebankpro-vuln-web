# SecureBank Pro (Intentionally Vulnerable Web Demo)

**SecureBank Pro** is a mock online banking portal designed for web security education, penetration testing practice, and security awareness training. It features a clean 2018-era neutral enterprise UI, a dual **Attack Mode / Secure Mode** architecture for side-by-side vulnerability analysis, and real-time backend telemetry counters.

> [!WARNING]
> This application contains intentional, critical security vulnerabilities. It must **only** be deployed in local lab environments or isolated Docker containers. **Never expose this portal to the public internet.**

---

## 🛠️ Technology Stack

- **Backend:** Node.js, Express.js
- **Database:** SQLite3 (Dual-table architecture for banking data and telemetry tracking)
- **Frontend / View Engine:** Server-rendered EJS templates, Minimal CSS (2018 Slate/Navy Corporate Theme)
- **Containerization:** Docker & Docker Compose

---

## 🚀 Quick Start & Installation

### Option 1: Running Locally with Node.js

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/securebankpro-vuln-web.git
cd securebankpro-vuln-web

# Install dependencies
npm install

# Start the server
npm start
```
Access the application at `http://localhost:3000`.

### Option 2: Running with Docker Compose

```bash
docker-compose up --build
```

---

## 🔑 Default Lab Accounts

| Username | Password | Role | Balance |
| :--- | :--- | :--- | :--- |
| `admin` | `admin` | Administrator | $50,000.00 |
| `john_doe` | `Password123` | Standard User | $2,500.50 |
| `alice_smith` | `AlicePass2018` | Standard User | $1,840.75 |

---

## 🔍 Detailed Implementation of the 6 Intentional Bugs

SecureBank Pro implements a **Dual-Controller Architecture**. Every vulnerable endpoint checks `req.session.isSecureMode` to execute either the vulnerable branch or the secure remediation branch.

### 1. SQL Injection (Critical)
- **Target Endpoint:** `POST /login`
- **Attack Mode Implementation:** User inputs (`username` and `password`) are concatenated directly into a raw SQL query string:
  ```javascript
  const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
  db.all(query, (err, rows) => { ... });
  ```
  - **Exploit Payload:** Entering `admin' --` into the Username field comments out the remainder of the query (`AND password = '...'`), logging the user in as Administrator without a password.
- **Secure Mode Remediation:** Employs Parameterized Queries (Prepared Statements). User inputs are strictly treated as data literals rather than executable SQL syntax:
  ```javascript
  db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => { ... });
  ```

---

### 2. Stored Cross-Site Scripting (XSS) (Critical)
- **Target Endpoint:** `POST /profile/update` & `GET /profile`
- **Attack Mode Implementation:** The "About Me" bio field accepts raw string data and stores it directly into SQLite. When rendering the profile, EJS outputs raw, unescaped HTML:
  ```html
  <%- user.about_me %>  <!-- Unescaped HTML rendering in EJS -->
  ```
  - **Exploit Payload:** Submitting `<script>alert('XSS')</script>` stores the script payload in the database. Every time the profile is viewed, the script executes in the browser.
- **Secure Mode Remediation:** EJS standard HTML entity escaping is enforced:
  ```html
  <%= user.about_me %>  <!-- Contextual HTML entity escaping in EJS -->
  ```

---

### 3. Insecure Direct Object Reference (IDOR) (Critical)
- **Target Endpoint:** `GET /transaction?id=...`
- **Attack Mode Implementation:** The endpoint queries transaction records directly using the user-supplied URL `id` query parameter without checking session ownership:
  ```javascript
  db.get(`SELECT * FROM transactions WHERE id = ${req.query.id}`, (err, row) => {
    res.render('transactions', { transaction: row });
  });
  ```
  - **Exploit Payload:** Logged in as `john_doe`, navigating to `/transaction?id=104` reveals the private transaction receipt belonging to `System Administrator` and `Alice Smith`.
- **Secure Mode Remediation:** Enforces strict authorization by checking that the authenticated session user ID matches either `sender_id` or `receiver_id`:
  ```javascript
  db.get(
    `SELECT * FROM transactions WHERE id = ? AND (sender_id = ? OR receiver_id = ?)`,
    [txnId, currentUserId, currentUserId],
    (err, row) => { ... }
  );
  ```

---

### 4. Cross-Site Request Forgery (CSRF) (Critical)
- **Target Endpoint:** `POST /transfer`
- **Attack Mode Implementation:** Fund transfers process automatically based solely on ambient session cookies without checking anti-CSRF state tokens:
  ```javascript
  app.post('/transfer', (req, res) => {
    const { recipient, amount } = req.body;
    // Executes transfer without validating origin or token
  });
  ```
  - **Exploit Payload:** An external malicious website can host an auto-submitting form targeting `http://localhost:3000/transfer` to silently transfer money out of an active session.
- **Secure Mode Remediation:** Generates a unique, cryptographically secure per-session `_csrf` token, injects it into hidden form inputs, and verifies it upon submission:
  ```javascript
  if (!_csrf || _csrf !== req.session.csrfToken) {
    return res.status(403).send('Security Violation: Invalid Anti-CSRF Token');
  }
  ```

---

### 5. Weak Authentication & Credential Abuse (Critical)
- **Target Endpoint:** `POST /login`
- **Attack Mode Implementation:** Account lockout logic is completely disabled, allowing unlimited automated credential brute-force attempts. Accounts use default/predictable credentials (`admin/admin`).
- **Secure Mode Remediation:** Tracks consecutive failed login attempts in the user session and locks out authentication after 5 failures:
  ```javascript
  if (req.session.failedLoginAttempts >= 5) {
    return res.render('login', { error: 'Account locked due to repeated failed attempts.' });
  }
  ```

---

### 6. Unvalidated File Upload (Critical)
- **Target Endpoint:** `POST /profile/upload`
- **Attack Mode Implementation:** Avatar uploads accept any arbitrary file extension (`.txt`, `.html`, `.php`, `.exe`) and save them directly to a public directory using original file names.
- **Secure Mode Remediation:** Enforces MIME-type validation (`image/*`), restricts file extensions to `.png`, `.jpg`, `.jpeg`, `.gif`, enforces a 2MB size limit, and renames uploaded files to randomized UUIDs:
  ```javascript
  if (!allowedExts.includes(originalExt) || !req.file.mimetype.startsWith('image/')) {
    fs.unlinkSync(req.file.path); // Remove dangerous file
    return res.render('profile', { error: 'Security Error: Only image files are permitted.' });
  }
  ```

---

## 📊 Real-Time Telemetry & Progress Dashboard

The backend contains a telemetry tracking engine (`telemetry` and `session_progress` tables in SQLite):
- **Exploit Attempt Counter:** Increments every time a vulnerability pattern or attempt is received.
- **Successful Solves Counter:** Increments **only** when an attack successfully achieves its objective (e.g. bypassing authentication, executing XSS in Attack Mode, or accessing unauthorized IDOR records).
- **Home Page Dashboard:** Displays overall stats (Total Sessions, Users who completed all 6 vulnerabilities, Total Exploit Attempts).

---

## 📜 License & Educational Disclaimer

This project is created strictly for educational and demonstration purposes. The authors assume no liability for misuse.
