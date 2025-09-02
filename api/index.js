const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// Konfigurasi Pool Koneksi PostgreSQL
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_VjRmJoXuk4T8@ep-morning-frost-a1skhmpr-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
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
        date DATE
      )`);
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


// Helper function to get local date in YYYY-MM-DD format
const getLocalDate = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// TRANSACTIONS API
app.post('/api/transactions', async (req, res) => {
  const { items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const item of items) {
      const { productName, quantity, costPrice, sellingPrice } = item;

      const productRes = await client.query('SELECT * FROM products WHERE name = $1', [productName]);
      const product = productRes.rows[0];

      if (!product) {
        throw new Error(`Produk ${productName} tidak ditemukan.`);
      }
      if (product.stock < quantity) {
        throw new Error(`Stok tidak mencukupi untuk produk ${productName}.`);
      }

      const newStock = product.stock - quantity;
      await client.query('UPDATE products SET stock = $1 WHERE name = $2', [newStock, productName]);

      const profitPerUnit = sellingPrice - costPrice;
      const total = quantity * sellingPrice;
      const date = getLocalDate();
      
      await client.query(
        'INSERT INTO transactions (productName, quantity, costPrice, sellingPrice, profitPerUnit, total, date) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [productName, quantity, costPrice, sellingPrice, profitPerUnit, total, date]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Transaksi berhasil dicatat.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/transactions', async (req, res) => {
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

app.delete('/api/transactions/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const transactionRes = await client.query('SELECT * FROM transactions WHERE id = $1', [id]);
        const transaction = transactionRes.rows[0];

        if (!transaction) {
            throw new Error('Transaksi tidak ditemukan.');
        }

        await client.query('UPDATE products SET stock = stock + $1 WHERE name = $2', [transaction.quantity, transaction.productName]);
        
        const deleteRes = await client.query('DELETE FROM transactions WHERE id = $1', [id]);
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

app.put('/api/transactions/:id', async (req, res) => {
    const { id } = req.params;
    const { quantity, costprice, sellingPrice } = req.body;
    const client = await pool.connect();

    let originalTransaction = null;
    try {
        await client.query('BEGIN');

        const transactionRes = await client.query('SELECT * FROM transactions WHERE id = $1', [id]);
        originalTransaction = transactionRes.rows[0];

        if (!originalTransaction) {
            throw new Error('Transaksi tidak ditemukan.');
        }

        const quantityDifference = quantity - originalTransaction.quantity;

        console.log('originalTransaction.productName:', originalTransaction.productName);
        const productRes = await client.query('SELECT * FROM products WHERE name ILIKE $1', [originalTransaction.productName]);
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
app.post('/api/products', async (req, res) => {
    const { name, stock, price, costprice } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO products (name, stock, price, costprice) VALUES ($1, $2, $3, $4) RETURNING id',
            [name, stock, price, costprice]
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/products', async (req, res) => {
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

app.put('/api/products/:id', async (req, res) => {
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

app.delete('/api/products/:id', async (req, res) => {
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


// EXPENSES API
app.post('/api/expenses', async (req, res) => {
    const { description, amount } = req.body;
    const date = getLocalDate();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const expenseRes = await client.query(
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

app.get('/api/expenses', async (req, res) => {
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

app.put('/api/expenses/:id', async (req, res) => {
    const { id } = req.params;
    const { description, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const expenseRes = await client.query('SELECT * FROM expenses WHERE id = $1', [id]);
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

app.delete('/api/expenses/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const expenseRes = await client.query('SELECT * FROM expenses WHERE id = $1', [id]);
        const expense = expenseRes.rows[0];
        if (!expense) {
            throw new Error('Expense not found.');
        }

        await client.query('INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3)', [expense.amount, expense.date, 'add']);
        
        const deleteRes = await client.query('DELETE FROM expenses WHERE id = $1', [id]);
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
app.post('/api/capital', async (req, res) => {
    const { amount, type } = req.body;
    const date = getLocalDate();
    try {
        const result = await pool.query(
            'INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3) RETURNING id',
            [amount, date, type]
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/capital/total', async (req, res) => {
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