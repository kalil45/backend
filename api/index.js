const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

app.use(cors({
  origin: 'https://appkasir-git-main-khalil-finandas-projects.vercel.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// Konfigurasi Pool Koneksi PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});


// ACCOUNTS API
app.get('/api/accounts', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM accounts");
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.post('/api/accounts', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const { name, balance } = req.body;
    const newAccount = await pool.query(
      "INSERT INTO accounts (name, balance) VALUES ($1, $2) RETURNING *",
      [name, balance]
    );
    res.status(201).json(newAccount.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.put('/api/accounts/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  const { id } = req.params;
  const { name, balance } = req.body;
  try {
    const result = await pool.query(
      'UPDATE accounts SET name = $1, balance = $2 WHERE id = $3 RETURNING *',
      [name, balance, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in PUT /accounts/:id:', err);
    res.status(400).json({ error: err.message || 'An unknown error occurred' });
  }
});

app.delete('/api/accounts/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if account has any associated transactions
    const transactionCheck = await client.query('SELECT 1 FROM transactions WHERE account_name = (SELECT name FROM accounts WHERE id = $1) LIMIT 1', [id]);
    if (transactionCheck.rowCount > 0) {
      throw new Error('Tidak dapat menghapus akun karena sudah ada transaksi terkait.');
    }

    const result = await pool.query('DELETE FROM accounts WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      throw new Error('Account not found.');
    }
    await client.query('COMMIT');
    res.json({ message: 'Account deleted successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in DELETE /accounts/:id:', err);
    res.status(400).json({ error: err.message || 'An unknown error occurred' });
  } finally {
    client.release();
  }
});

// --- PERBAIKAN UNTUK DATABASE INITIALIZATION ---
let dbInitialized = false;

const initializeDatabase = async () => {
  if (dbInitialized) return;

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        productName TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        costPrice NUMERIC NOT NULL,
        sellingPrice NUMERIC NOT NULL,
        profitPerUnit NUMERIC,
        total NUMERIC,
        date DATE,
        account_name TEXT,
        type TEXT,
        description TEXT,
        paymentMethod TEXT
      )`);
    await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_name TEXT`); // Add this line
    await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type TEXT`);
    await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description TEXT`);
    await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paymentMethod TEXT`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        stock INTEGER NOT NULL,
        price NUMERIC NOT NULL,
        costPrice NUMERIC NOT NULL
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        description TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        date DATE
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS capital_history (
        id SERIAL PRIMARY KEY,
        amount NUMERIC NOT NULL,
        date DATE NOT NULL,
        type TEXT NOT NULL
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        balance NUMERIC NOT NULL DEFAULT 0
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id SERIAL PRIMARY KEY,
        productId INTEGER REFERENCES products(id),
        accountId INTEGER REFERENCES accounts(id),
        quantity INTEGER NOT NULL,
        purchasePrice NUMERIC NOT NULL,
        total NUMERIC NOT NULL,
        date DATE NOT NULL
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'kasir'
      )`);
    console.log('Database tables checked/created successfully.');
    dbInitialized = true; // Tandai bahwa inisialisasi sudah selesai
  } catch (err) {
    console.error('Error initializing database:', err.message);
    throw err; // Lemparkan error agar proses berhenti jika gagal
  } finally {
    client.release();
  }
};

// Middleware untuk memastikan database siap sebelum setiap request
app.use(async (req, res, next) => {
  try {
    await initializeDatabase();
    next();
  } catch (err) {
    res.status(500).json({ error: 'Failed to initialize database.' });
  }
});
// --- AKHIR PERBAIKAN ---

// AUTHENTICATION API
app.post('/api/register', async (req, res) => {
  const { username, password, role } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10); // Hash password with salt rounds = 10
    const newUser = await pool.query(
      "INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, role",
      [username, hashedPassword, role || 'kasir'] // Default role to 'kasir'
    );
    res.status(201).json({ message: "User registered successfully", user: newUser.rows[0] });
  } catch (err) {
    console.error('Error in POST /api/register:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = userRes.rows[0];

    if (!user) {
      return res.status(400).json({ error: 'Invalid Credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid Credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '1h' } // Token expires in 1 hour
    );

    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });

  } catch (err) {
    console.error('Error in POST /api/login:', err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Middleware for authenticating JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (token == null) return res.status(401).json({ error: 'Authentication token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// Middleware for role-based access control
const authorizeRole = (roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient role permissions' });
    }
    next();
  };
};






// Helper function to get local date in YYYY-MM-DD format
const getLocalDate = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// TRANSACTIONS API
app.post('/api/transactions', authenticateToken, authorizeRole(['admin', 'kasir']), async (req, res) => {
  const { type, accountName, amount, description, productName, quantity, costPrice, sellingPrice } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const date = getLocalDate();

    if (type === 'withdrawal') {
      // Handle cash withdrawal
      if (!accountName || !amount || amount <= 0) {
        throw new Error('Nama akun dan jumlah penarikan harus valid.');
      }

      const accountRes = await client.query('SELECT * FROM accounts WHERE name = $1 FOR UPDATE', [accountName]);
      const account = accountRes.rows[0];

      if (!account) {
        throw new Error('Akun tidak ditemukan.');
      }
      if (account.balance < amount) {
        throw new Error('Saldo tidak mencukupi di akun yang dipilih.');
      }

      const newBalance = account.balance - amount;
      await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [newBalance, account.id]);

      // Insert into capital_history as a subtraction
      await client.query('INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3)', [amount, date, 'subtract']);

      // Insert into transactions table for logging purposes (simplified)
      await client.query(
        'INSERT INTO transactions (productName, quantity, costPrice, sellingPrice, profitPerUnit, total, date, account_name, type, description) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
        ['Penarikan Tunai', 0, 0, 0, 0, amount, date, accountName, 'withdrawal', description || 'Penarikan Tunai']
      );

      await client.query('COMMIT');
      res.status(201).json({ message: 'Penarikan tunai berhasil dicatat.' });

    } else {
      // Handle sales transaction (original logic)
      const { productName, quantity, costPrice, sellingPrice, accountName, paymentMethod } = req.body; // Added paymentMethod
      // Validate required fields for sales transaction
      if (!productName || !accountName ||
          quantity === null || quantity === undefined || isNaN(quantity) ||
          costPrice === null || costPrice === undefined || isNaN(costPrice) ||
          sellingPrice === null || sellingPrice === undefined || isNaN(sellingPrice)) {
        throw new Error('Data transaksi penjualan tidak lengkap. Pastikan semua kolom terisi dengan benar.');
      }

      const productRes = await client.query('SELECT * FROM products WHERE name = $1', [productName]);
      const product = productRes.rows[0];

      if (!product) {
        throw new Error('Produk tidak ditemukan.');
      }
      if (product.stock < quantity) {
        throw new Error('Stok tidak mencukupi.');
      }

      const newStock = product.stock - quantity;
      await client.query('UPDATE products SET stock = $1 WHERE name = $2', [newStock, productName]);

      const profitPerUnit = sellingPrice - costPrice;
      const total = quantity * sellingPrice;
      const totalCost = quantity * costPrice; // Calculate total cost
      const date = getLocalDate(); // Ensure date is available

      if (paymentMethod === 'BSI Transfer') {
        // Logic for BSI Transfer sales
        // Credit the selected account (e.g., BSI account) with the total selling price
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE name = $2', [total, accountName]);

        // Debit the "Modal Tersisa" account with the total cost price
        const modalTersisaAccountName = 'Modal Tersisa';
        const modalTersisaAccountRes = await client.query('SELECT * FROM accounts WHERE name = $1 FOR UPDATE', [modalTersisaAccountName]);
        const modalTersisaAccount = modalTersisaAccountRes.rows[0];

        if (!modalTersisaAccount) {
          throw new Error(`Akun '${modalTersisaAccountName}' tidak ditemukan. Mohon buat akun ini terlebih dahulu.`);
        }
        if (modalTersisaAccount.balance < totalCost) {
          throw new Error(`Saldo di akun '${modalTersisaAccountName}' tidak mencukupi untuk mengurangi harga modal.`);
        }
        await client.query('UPDATE accounts SET balance = balance - $1 WHERE name = $2', [totalCost, modalTersisaAccountName]);

      } else {
        // Original logic for other sales (e.g., cash sales)
        await client.query('UPDATE accounts SET balance = balance - $1 WHERE name = $2', [totalCost, accountName]); // Deduct totalCost from account balance
      }

      // Debit the "Modal Tersisa" account with the total cost price
      const modalTersisaAccountName = 'Modal Tersisa'; // Hardcoded name for the global account
      const modalTersisaAccountRes = await client.query('SELECT * FROM accounts WHERE name = $1 FOR UPDATE', [modalTersisaAccountName]);
      const modalTersisaAccount = modalTersisaAccountRes.rows[0];

      if (!modalTersisaAccount) {
        throw new Error(`Akun '${modalTersisaAccountName}' tidak ditemukan. Mohon buat akun ini terlebih dahulu.`);
      }
      if (modalTersisaAccount.balance < totalCost) {
        throw new Error(`Saldo di akun '${modalTersisaAccountName}' tidak mencukupi untuk mengurangi harga modal.`);
      }
      await client.query('UPDATE accounts SET balance = balance - $1 WHERE name = $2', [totalCost, modalTersisaAccountName]);


      const insertRes = await client.query(
        'INSERT INTO transactions (productName, quantity, costPrice, sellingPrice, profitPerUnit, total, date, account_name, type, paymentMethod) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
        [productName, quantity, costPrice, sellingPrice, profitPerUnit, total, date, accountName, 'sale', paymentMethod || 'Cash'] // Default to 'Cash' if paymentMethod is not provided
      );

      await client.query('INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3)', [total, date, 'add']);
      await client.query('COMMIT');
      res.status(201).json({ id: insertRes.rows[0].id });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in POST /transactions:', err);
    res.status(400).json({ error: err.message || 'An unknown error occurred' });
  } finally {
    client.release();
  }
});

app.get('/api/transactions', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { startDate, endDate } = req.query;
    let sql = `SELECT * FROM transactions`;
    const params = [];
    if (startDate && endDate) {
        sql += ' WHERE date BETWEEN $1 AND $2';
        params.push(startDate, endDate);
    }
    sql += ' ORDER BY date DESC, id DESC';

    try {
        const { rows } = await pool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/transactions/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const transactionRes = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
        const transaction = transactionRes.rows[0];

        if (!transaction) {
            throw new Error('Transaksi tidak ditemukan.');
        }

        await client.query('UPDATE products SET stock = stock + $1 WHERE name = $2', [transaction.quantity, transaction.productName]);
        
        const deleteRes = await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
        if (deleteRes.rowCount === 0) {
            throw new Error('Gagal menghapus transaksi.');
        }

        await client.query('COMMIT');
        res.json({ message: 'Transaksi berhasil dihapus dan stok dikembalikan.' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.put('/api/transactions/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { id } = req.params;
    const { quantity, costprice, sellingPrice } = req.body;
    const client = await pool.connect();

    let originalTransaction = null;
    try {
        await client.query('BEGIN');

        const transactionRes = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
        originalTransaction = transactionRes.rows[0];

        if (!originalTransaction) {
            throw new Error('Transaksi tidak ditemukan.');
        }

        const quantityDifference = quantity - originalTransaction.quantity;

        console.log('originalTransaction.productName:', originalTransaction.productName);
        const productRes = await pool.query('SELECT * FROM products WHERE name ILIKE $1', [originalTransaction.productName]);
        const product = productRes.rows[0];
        console.log('Product found by ILIKE query:', product);

        if (!product) {
            throw new Error('Produk tidak ditemukan.');
        }
        if (product.stock < quantityDifference) {
            throw new Error('Stok tidak mencukupi untuk pembaruan ini.');
        }

        const newStock = product.stock - quantityDifference;
        await client.query('UPDATE products SET stock = $1 WHERE name = $2', [newStock, originalTransaction.productName]);

        const newTotal = quantity * sellingPrice;
        const newProfitPerUnit = sellingPrice - costPrice;
        await client.query(
            'UPDATE transactions SET quantity = $1, costprice = $2, sellingPrice = $3, total = $4, profitPerUnit = $5 WHERE id = $6',
            [quantity, costprice, sellingPrice, newTotal, newProfitPerUnit, id]
        );

        await client.query('COMMIT');
        res.json({ message: 'Transaksi berhasil diperbarui.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error in PUT /api/transactions/:id:', err.message);
        res.status(400).json({
            error: err.message,
            debug: {
                originalTransaction: originalTransaction,
                // Add other relevant debug info here if needed
            }
        });
    } finally {
        client.release();
    }
});


// PRODUCTS API
app.post('/api/products', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { name, stock, price, costPrice } = req.body; // Changed costprice to costPrice
    try {
        const result = await pool.query(
            'INSERT INTO products (name, stock, price, costPrice) VALUES ($1, $2, $3, $4) RETURNING id', // Changed costprice to costPrice
            [name, stock, price, costPrice] // Changed costprice to costPrice
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/products', authenticateToken, authorizeRole(['admin', 'kasir']), async (req, res) => {
    const { search } = req.query;
    let sql = `SELECT * FROM products`;
    let params = [];
    if (search) {
        sql += ` WHERE name ILIKE $1`; // ILIKE for case-insensitive search in PostgreSQL
        params.push(`%${search}%`);
    }
    sql += ` ORDER BY name ASC`;
    try {
        const { rows } = await pool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/products/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { id } = req.params;
    const { stock } = req.body;
    try {
        const result = await pool.query('UPDATE products SET stock = $1 WHERE id = $2', [stock, id]);
        if (result.rowCount === 0) {
            res.status(404).json({ error: 'Product not found.' });
        } else {
            res.json({ message: 'Product stock updated successfully.' });
        }
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/products/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const productRes = await pool.query('SELECT name FROM products WHERE id = $1', [id]);
        if (productRes.rowCount === 0) {
            return res.status(404).json({ error: 'Produk tidak ditemukan.' });
        }
        
        const productName = productRes.rows[0].name;
        const transactionCheck = await pool.query('SELECT 1 FROM transactions WHERE productName = $1 LIMIT 1', [productName]);
        
        if (transactionCheck.rowCount > 0) {
            return res.status(400).json({ error: 'Tidak dapat menghapus produk karena sudah ada transaksi terkait.' });
        }

        const deleteRes = await pool.query('DELETE FROM products WHERE id = $1', [id]);
        if (deleteRes.rowCount === 0) {
            return res.status(404).json({ error: 'Gagal menghapus produk.' });
        }
        res.json({ message: 'Produk berhasil dihapus.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PURCHASES API
app.post('/api/purchases', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  const { productId, accountId, quantity, purchasePrice } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const total = quantity * purchasePrice;
    const date = getLocalDate();

    // Deduct from account balance
    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [total, accountId]);

    // Add to product stock
    await client.query('UPDATE products SET stock = stock + $1, costprice = $2 WHERE id = $3', [quantity, purchasePrice, productId]);

    const insertRes = await client.query(
      'INSERT INTO purchases (productId, accountId, quantity, purchasePrice, total, date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [productId, accountId, quantity, purchasePrice, total, date]
    );

    const newPurchaseId = insertRes.rows[0].id;

    const newPurchaseRes = await client.query(`
        SELECT p.id, pr.name as productName, p.quantity, p.purchasePrice, p.total, p.date 
        FROM purchases p
        JOIN products pr ON p.productId = pr.id
        WHERE p.id = $1
    `, [newPurchaseId]);

    await client.query('COMMIT');
    res.status(201).json(newPurchaseRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in POST /purchases:', err);
    res.status(400).json({ error: err.message || 'An unknown error occurred' });
  } finally {
    client.release();
  }
});

app.get('/api/purchases', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT p.id, pr.name as productName, p.quantity, p.purchasePrice, p.total, p.date 
            FROM purchases p
            JOIN products pr ON p.productId = pr.id
            ORDER BY p.date DESC, p.id DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});


// EXPENSES API
app.post('/api/expenses', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { description, amount } = req.body;
    const date = getLocalDate();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const expenseRes = await pool.query(
            'INSERT INTO expenses (description, amount, date) VALUES ($1, $2, $3) RETURNING id',
            [description, amount, date]
        );
        await client.query(
            'INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3)',
            [amount, date, 'subtract']
        );
        await client.query('COMMIT');
        res.status(201).json({ id: expenseRes.rows[0].id });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/expenses', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { startDate, endDate } = req.query;
    let sql = `SELECT * FROM expenses`;
    const params = [];
    if (startDate && endDate) {
        sql += ' WHERE date BETWEEN $1 AND $2';
        params.push(startDate, endDate);
    }
    sql += ' ORDER BY date DESC, id DESC';
    try {
        const { rows } = await pool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/expenses/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { id } = req.params;
    const { description, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const expenseRes = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
        const originalExpense = expenseRes.rows[0];
        if (!originalExpense) {
            throw new Error('Expense not found.');
        }

        // Restore old capital amount
        await client.query('INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3)', [originalExpense.amount, originalExpense.date, 'add']);
        // Subtract new capital amount
        await client.query('INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3)', [amount, originalExpense.date, 'subtract']);
        
        await client.query('UPDATE expenses SET description = $1, amount = $2 WHERE id = $3', [description, amount, id]);
        
        await client.query('COMMIT');
        res.json({ message: 'Expense updated successfully.' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/expenses/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const expenseRes = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
        const expense = expenseRes.rows[0];
        if (!expense) {
            throw new Error('Expense not found.');
        }

        await client.query('INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3)', [expense.amount, expense.date, 'add']);
        
        const deleteRes = await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
        if (deleteRes.rowCount === 0) {
            throw new Error('Failed to delete expense.');
        }

        await client.query('COMMIT');
        res.json({ message: 'Expense deleted successfully and capital restored.' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});


// CAPITAL API
app.post('/api/capital', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { amount, type } = req.body;
    const date = getLocalDate();
    const client = await pool.connect(); // Get a client for transaction
    try {
        await client.query('BEGIN'); // Start transaction

        const modalTersisaAccountName = 'Modal Tersisa';
        const accountRes = await client.query('SELECT * FROM accounts WHERE name = $1 FOR UPDATE', [modalTersisaAccountName]);
        const account = accountRes.rows[0];

        if (!account) {
            throw new Error(`Akun '${modalTersisaAccountName}' tidak ditemukan. Mohon buat akun ini terlebih dahulu.`);
        }

        let newBalance;
        if (type === 'add') {
            newBalance = account.balance + amount;
        } else if (type === 'subtract') {
            if (account.balance < amount) {
                throw new Error(`Saldo di akun '${modalTersisaAccountName}' tidak mencukupi untuk mengurangi modal.`);
            }
            newBalance = account.balance - amount;
        } else {
            throw new Error('Tipe operasi modal tidak valid. Gunakan \'add\' atau \'subtract\'.');
        }

        await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [newBalance, account.id]);

        const result = await pool.query(
            'INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3) RETURNING id',
            [amount, date, type]
        );

        await client.query('COMMIT'); // Commit transaction
        res.status(201).json({ id: result.rows[0].id, newBalance });
    } catch (err) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error('Error in POST /capital:', err.message);
        res.status(400).json({ error: err.message });
    } finally {
        client.release(); // Release client
    }
});

app.get('/api/capital/total', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT SUM(CASE WHEN type = 'add' THEN amount ELSE -amount END) AS totalCapital FROM capital_history`);
        const totalCapital = rows[0].totalcapital || 0;
        res.json({ totalCapital });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});


// Export aplikasi Express untuk Vercel
module.exports = app;