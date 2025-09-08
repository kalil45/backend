const { quantity, costPrice, sellingPrice } = req.body;
const client = await pool.connect();

try {
await client.query('BEGIN');

const transactionRes = await client.query('SELECT *
const originalTransaction = transactionRes.rows[0];

if (!originalTransaction) {
throw new Error('Transaksi tidak ditemukan.');
}

const quantityDifference = quantity - originalTransa

const productRes = await client.query('SELECT * FROM
const product = productRes.rows[0];

if (!product) {
throw new Error('Produk tidak ditemukan.');
}
if (product.stock < quantityDifference) {
throw new Error('Stok tidak mencukupi untuk pemb
}

const newStock = product.stock - quantityDifference;
await client.query('UPDATE products SET stock = $1 W

const newTotal = quantity * sellingPrice;
const newProfitPerUnit = sellingPrice - costPrice;
await client.query(
'UPDATE transactions SET quantity = $1, costPric
[quantity, costPrice, sellingPrice, newTotal, ne
);

await client.query('COMMIT');
res.json({ message: 'Transaksi berhasil diperbarui.'
} catch (err) {
await client.query('ROLLBACK');
res.status(400).json({ error: err.message });
} finally {
client.release();
}
});


// PRODUCTS API
app.post('/api/products', async (req, res) => {
const { name, stock, price, costPrice, accountName } = req.body; // Added accountName
const client = await pool.connect(); // Get a client for transaction
try {
await client.query('BEGIN'); // Start transaction

// Deduct from account
const accountRes = await client.query('SELECT * FROM accounts WHERE name = $1 FOR UPDATE', [accountName]);
const account = accountRes.rows[0];

if (!account) {
  throw new Error('Account not found.');
}

if (account.balance < costPrice) { // Deduct costPrice
  throw new Error('Insufficient balance in selected account.');
}

const newBalance = account.balance - costPrice;
await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [newBalance, account.id]);

// Insert product
const result = await client.query(
'INSERT INTO products (name, stock, price, costPrice) VALUES ($1, $2, $3, $4) RETURNING id',
[name, stock, price, costPrice]
);

await client.query('COMMIT'); // Commit transaction
res.status(201).json({ id: expenseRes.rows[0].id, message: 'Expense added and account updated successfully.' });
} catch (err) {
await client.query('ROLLBACK'); // Rollback on error
console.error(err.message);
res.status(400).json({ error: err.message });
} finally {
client.release(); // Release client
}
});

app.get('/api/products', async (req, res) => {
const { search } = req.query;
let sql = `SELECT * FROM products`;
let params = [];
if (search) {
sql += ` WHERE name ILIKE $1`; // ILIKE for case-ins
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
const result = await pool.query('UPDATE products SET
if (result.rowCount === 0) {
res.status(404).json({ error: 'Product not found
} else {
res.json({ message: 'Product stock updated succe
}
} catch (err) {
res.status(400).json({ error: err.message });
}
});

app.delete('/api/products/:id', async (req, res) => {
const { id } = req.params;
try {
const productRes = await pool.query('SELECT name FRO
if (productRes.rowCount === 0) {
return res.status(404).json({ error: 'Produk tid
}

const productName = productRes.rows[0].name;
const transactionCheck = await pool.query('SELECT 1

if (transactionCheck.rowCount > 0) {
return res.status(400).json({ error: 'Tidak dapa
}

const deleteRes = await pool.query('DELETE FROM prod
if (deleteRes.rowCount === 0) {
return res.status(404).json({ error: 'Gagal meng
}
res.json({ message: 'Produk berhasil dihapus.' });
} catch (err) {
res.status(500).json({ error: err.message });
}
});


//EXPENSES API
app.post('/api/expenses', async (req, res) => {
const { description, amount, accountName } = req.body; // Added accountName
const date = getLocalDate(); // Assuming getLocalDate() is defined elsewhere
const client = await pool.connect();
try {
await client.query('BEGIN');

// Deduct from account
const accountRes = await client.query('SELECT * FROM accounts WHERE name = $1 FOR UPDATE', [accountName]);
const account = accountRes.rows[0];

if (!account) {
throw new Error('Account not found.');
}

if (account.balance < amount) {
throw new Error('Insufficient balance in selected account.');
}

const newBalance = account.balance - amount;
await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [newBalance, account.id]);

// Original expense insertion logic
const expenseRes = await client.query(
'INSERT INTO expenses (description, amount, date) VALUES ($1, $2, $3) RETURNING id',
[description, amount, date]
);
await client.query(
'INSERT INTO capital_history (amount, date, type) VALUES ($1, $2, $3)',
[amount, date, 'subtract']
);

await client.query('COMMIT');
res.status(201).json({ id: expenseRes.rows[0].id, message: 'Expense added and account updated successfully.' });
} catch (err) {
await client.query('ROLLBACK');
console.error(err.message);
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

const expenseRes = await client.query('SELECT * FROM
const expense = expenseRes.rows[0];
if (!expense) {
throw new Error('Expense not found.');
}

await client.query('INSERT INTO capital_history (amo

const deleteRes = await pool.query('DELETE FROM ex
if (deleteRes.rowCount === 0) {
throw new Error('Failed to delete expense.');
}

await client.query('COMMIT');
res.json({ message: 'Expense deleted successfully an
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
'INSERT INTO capital_history (amount, date, type
[amount, date, type]
);
res.status(201).json({ id: result.rows[0].id });
} catch (err) {
res.status(400).json({ error: err.message });
}
});

app.get('/api/capital/total', async (req, res) => {
try {
const { rows } = await pool.query(`SELECT SUM(CASE W
const totalCapital = rows[0].totalcapital || 0;
res.json({ totalCapital });
} catch (err) {
res.status(400).json({ error: err.message });
}
});


// ACCOUNTS API
app.post('/api/accounts', async (req, res) => {
  const { name, balance } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO accounts (name, balance) VALUES ($1, $2) RETURNING id',
      [name, balance]
    );
    res.status(201).json({ id: result.rows[0].id, name, balance });
  } catch (err) {
    console.error(err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM accounts ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/accounts/deduct', async (req, res) => {
  const { accountName, amount } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const accountRes = await client.query('SELECT * FROM accounts WHERE name = $1 FOR UPDATE', [accountName]);
    const account = accountRes.rows[0];

    if (!account) {
      throw new Error('Account not found.');
    }

    if (account.balance < amount) {
      throw new Error('Insufficient balance.');
    }

    const newBalance = account.balance - amount;
    await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [newBalance, account.id]);

    await client.query('COMMIT');
    res.json({ message: 'Balance deducted successfully.', newBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});


// Start the server and initialize database
app.listen(port, () => {
console.log(`Server running on port ${port}`);
initializeDatabase();
});

function initializeDatabase() {
    // ... (existing table creations) ...
    await pool.query(`
        CREATE TABLE IF NOT EXISTS capital_history (
            id SERIAL PRIMARY KEY,
            amount NUMERIC(10, 2) NOT NULL,
            date DATE NOT NULL,
            type VARCHAR(50) NOT NULL
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) UNIQUE NOT NULL,
            balance NUMERIC(10, 2) NOT NULL DEFAULT 0
        );
    `);
}