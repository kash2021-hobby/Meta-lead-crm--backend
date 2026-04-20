require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Sequelize, DataTypes, Op } = require('sequelize');
const cron = require('node-cron');
const { google } = require('googleapis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios'); // ADDED FOR TELEGRAM

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_change_me';

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  { host: process.env.DB_HOST, dialect: 'mysql', logging: false }
);

// --- MODELS ---
const Company = sequelize.define('Company', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING, allowNull: false },
  username: { type: DataTypes.STRING, allowNull: false, unique: true },
  plain_password: { type: DataTypes.STRING, allowNull: false }, 
  telegram_bot_token: { type: DataTypes.STRING, allowNull: true }, // NEW
  telegram_chat_id: { type: DataTypes.STRING, allowNull: true }, // NEW
});

const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  username: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false }, 
  role: { type: DataTypes.ENUM('superadmin', 'client'), defaultValue: 'client' }
});

const Campaign = sequelize.define('Campaign', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING, allowNull: false },
  sheet_id: { type: DataTypes.STRING, allowNull: false, unique: true },
});

const Lead = sequelize.define('Lead', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING, allowNull: true },
  phone: { type: DataTypes.STRING, allowNull: false, unique: true },
  email: { type: DataTypes.STRING, allowNull: true },
  source_sheet_id: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.ENUM('new', 'contacted', 'followup', 'converted'), defaultValue: 'new' },
  notes: { type: DataTypes.TEXT, allowNull: true }, 
  details: { type: DataTypes.JSON, allowNull: true }, 
  reminder_date: { type: DataTypes.DATE, allowNull: true },
  reminder_sent: { type: DataTypes.BOOLEAN, defaultValue: false },
});

const Activity = sequelize.define('Activity', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  type: { type: DataTypes.ENUM('call', 'message', 'meeting', 'note', 'system'), allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false },
});

// Relationships
Company.hasMany(User, { foreignKey: 'company_id', onDelete: 'CASCADE' });
User.belongsTo(Company, { foreignKey: 'company_id' });
Company.hasMany(Campaign, { foreignKey: 'company_id', onDelete: 'CASCADE' });
Campaign.belongsTo(Company, { foreignKey: 'company_id' });
Campaign.hasMany(Lead, { foreignKey: 'campaign_id', onDelete: 'CASCADE' });
Lead.belongsTo(Campaign, { foreignKey: 'campaign_id' });
Lead.hasMany(Activity, { foreignKey: 'lead_id', onDelete: 'CASCADE' });
Activity.belongsTo(Lead, { foreignKey: 'lead_id' });

// --- UTILS & TELEGRAM ---
const logInfo = (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`);
const logError = (msg, err) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, err?.message || err);

// NEW: TELEGRAM SENDER
const sendTelegramAlert = async (companyId, message) => {
  try {
    const company = await Company.findByPk(companyId);
    if (company && company.telegram_bot_token && company.telegram_chat_id) {
      await axios.post(`https://api.telegram.org/bot${company.telegram_bot_token}/sendMessage`, {
        chat_id: company.telegram_chat_id,
        text: message,
        parse_mode: 'Markdown'
      });
    }
  } catch (error) { logError("Telegram Error", error); }
};

const normalizeData = (rows) => {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map(h => h.toLowerCase().trim());
  const leads = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowData = {};
    headers.forEach((h, idx) => { rowData[h] = row[idx] || ''; });
    let phone = (rowData['phone'] || rowData['phone_number'] || '').replace(/\D/g, ''); 
    let name = rowData['full_name'] || rowData['first_name'] || rowData['name'] || 'Unknown';
    if (phone && phone.length >= 10) leads.push({ name, phone, email: rowData['email'] || null, details: rowData });
  }
  return leads;
};

// --- GOOGLE SHEETS & CRON ---
let authOptions = { scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] };
if (process.env.GOOGLE_CREDENTIALS) {
  try { authOptions.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); } 
  catch (err) { logError("Failed to parse GOOGLE_CREDENTIALS", err); }
} else {
  authOptions.keyFile = './google-credentials.json';
}
const auth = new google.auth.GoogleAuth(authOptions);
const sheets = google.sheets({ version: 'v4', auth });

const fetchAndSyncLeads = async () => {
  try {
    const campaigns = await Campaign.findAll();
    for (const campaign of campaigns) {
      try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: campaign.sheet_id, range: 'A:Z' });
        const normalizedLeads = normalizeData(response.data.values);
        for (const leadData of normalizedLeads) {
          const exists = await Lead.findOne({ where: { phone: leadData.phone } });
          if (!exists) {
            const newLead = await Lead.create({ ...leadData, source_sheet_id: campaign.sheet_id, campaign_id: campaign.id });
            await Activity.create({ lead_id: newLead.id, type: 'system', content: 'Client added to CRM via Sheets Integration' });
            
            // SEND NEW LEAD TELEGRAM ALERT
            await sendTelegramAlert(campaign.company_id, `🚨 *NEW LEAD (Auto-Sync)*\n\n*Name:* ${newLead.name}\n*Phone:* ${newLead.phone}\n*Campaign:* ${campaign.name}`);
          }
        }
      } catch(e) {} 
    }
  } catch (dbErr) { logError("Database/Sheets error during sync", dbErr); }
};

const checkReminders = async () => {
  try {
    const now = new Date();
    const dueLeads = await Lead.findAll({
      where: { status: 'followup', reminder_date: { [Op.lte]: now }, reminder_sent: false },
      include: [Campaign]
    });
    for (const lead of dueLeads) {
      lead.reminder_sent = true;
      await lead.save();
      await Activity.create({ lead_id: lead.id, type: 'system', content: 'Automated follow-up reminder triggered.' });
      
      // SEND FOLLOW UP TELEGRAM ALERT
      if (lead.Campaign) {
        await sendTelegramAlert(lead.Campaign.company_id, `⏰ *FOLLOW-UP REMINDER*\n\nIt is time to contact *${lead.name || 'Client'}*\n*Phone:* ${lead.phone}\n*Campaign:* ${lead.Campaign.name}\n*Notes:* ${lead.notes || 'No notes left.'}`);
      }
    }
  } catch (error) { logError("Reminder Check Error", error); }
};

cron.schedule('* * * * *', fetchAndSyncLeads);
cron.schedule('* * * * *', checkReminders); // Checks every minute for due reminders

// --- AUTHENTICATION & MIDDLEWARE ---
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // UPDATED: Added include: [Company] so the backend grabs the company name!
    const user = await User.findOne({ where: { username }, include: [Company] });
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, company_id: user.company_id }, JWT_SECRET, { expiresIn: '24h' });
    
    // UPDATED: Sending company_name back to the React app
    res.json({ 
      success: true, 
      token, 
      username: user.username, 
      role: user.role, 
      company_id: user.company_id,
      company_name: user.Company ? user.Company.name : 'Agency CRM'
    });
  } catch (error) { res.status(500).json({ error: "Login failed" }); }
});

const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1]; 
  if (!token) return res.status(401).json({ error: 'Access denied.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token.' });
    req.user = user; 
    next();
  });
};

const requireSuperAdmin = (req, res, next) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Super Admin access required.' });
  next();
};

// --- API ROUTES (PROTECTED) ---

app.post('/api/sync', authenticateToken, async (req, res) => {
  try { await fetchAndSyncLeads(); res.status(200).json({ message: "Sync complete" }); } 
  catch (error) { res.status(500).json({ error: error.message }); }
});

// COMPANIES 
app.get('/api/companies', authenticateToken, requireSuperAdmin, async (req, res) => {
  res.json(await Company.findAll({ order: [['createdAt', 'DESC']] }));
});

app.post('/api/companies', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { name, username, password } = req.body;
    const existing = await User.findOne({ where: { username } });
    if (existing) return res.status(400).json({ error: 'Username already taken' });

    const company = await Company.create({ name, username, plain_password: password });
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword, role: 'client', company_id: company.id });
    
    res.status(201).json(company);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// NEW: UPDATE COMPANY (For Telegram Settings)
app.patch('/api/companies/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { telegram_bot_token, telegram_chat_id } = req.body;
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    
    company.telegram_bot_token = telegram_bot_token;
    company.telegram_chat_id = telegram_chat_id;
    await company.save();
    res.json(company);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/companies/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    await Company.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// CAMPAIGNS
app.get('/api/campaigns', authenticateToken, async (req, res) => {
  const whereClause = req.user.role === 'client' ? { company_id: req.user.company_id } : {};
  if (req.user.role === 'superadmin' && req.query.company_id) whereClause.company_id = req.query.company_id;
  res.json(await Campaign.findAll({ where: whereClause }));
});

app.post('/api/campaigns', authenticateToken, async (req, res) => {
  try { 
    const campaignData = { ...req.body };
    if (req.user.role === 'client') campaignData.company_id = req.user.company_id;
    const campaign = await Campaign.create(campaignData); 
    fetchAndSyncLeads(); 
    res.status(201).json(campaign); 
  } catch (error) { 
    if (error.name === 'SequelizeUniqueConstraintError') return res.status(400).json({ error: "Sheet ID is already connected!" });
    res.status(500).json({ error: error.message }); 
  }
});

app.delete('/api/campaigns/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    await Campaign.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// LEADS
app.get('/api/leads', authenticateToken, async (req, res) => {
  let includeClause = [{ model: Campaign }];
  if (req.user.role === 'client') includeClause = [{ model: Campaign, where: { company_id: req.user.company_id } }];
  else if (req.user.role === 'superadmin' && req.query.company_id) includeClause = [{ model: Campaign, where: { company_id: req.query.company_id } }];
  const whereClause = req.query.campaign_id ? { campaign_id: req.query.campaign_id } : {};
  res.json(await Lead.findAll({ where: whereClause, include: includeClause, order: [['createdAt', 'DESC']] }));
});

// NEW: ADD MANUAL LEAD
app.post('/api/leads', authenticateToken, async (req, res) => {
  try {
    const { name, phone, email, campaign_id, notes } = req.body;
    const campaign = await Campaign.findByPk(campaign_id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const exists = await Lead.findOne({ where: { phone } });
    if (exists) return res.status(400).json({ error: "A lead with this phone number already exists." });

    const newLead = await Lead.create({ name, phone, email, campaign_id, source_sheet_id: 'manual', notes, status: 'new' });
    await Activity.create({ lead_id: newLead.id, type: 'system', content: 'Lead manually added to CRM' });

    // Send Telegram Alert for Manual Lead
    await sendTelegramAlert(campaign.company_id, `🚨 *NEW LEAD (Manual Entry)*\n\n*Name:* ${newLead.name}\n*Phone:* ${newLead.phone}\n*Campaign:* ${campaign.name}\n*Notes:* ${notes || 'None'}`);

    res.status(201).json(newLead);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch('/api/leads/:id', authenticateToken, async (req, res) => {
  try {
    const { status, notes, reminder_date } = req.body;
    const lead = await Lead.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (status) lead.status = status;
    if (notes !== undefined) lead.notes = notes; 
    if (reminder_date !== undefined) { lead.reminder_date = reminder_date; lead.reminder_sent = false; }
    await lead.save();
    res.json(lead);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/leads/all', authenticateToken, requireSuperAdmin, async (req, res) => {
  try { await Lead.destroy({ where: {} }); res.json({ success: true, message: 'All leads globally deleted.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ACTIVITIES
app.get('/api/leads/:id/activities', authenticateToken, async (req, res) => {
  res.json(await Activity.findAll({ where: { lead_id: req.params.id }, order: [['createdAt', 'DESC']] }));
});

app.post('/api/leads/:id/activities', authenticateToken, async (req, res) => {
  try {
    const activity = await Activity.create({ lead_id: req.params.id, type: req.body.type, content: req.body.content });
    res.status(201).json(activity);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- INITIALIZE ---
sequelize.authenticate().then(() => {
  sequelize.sync({ alter: true }).then(async () => { 
    const existingAdmin = await User.findOne({ where: { username: 'admin' } });
    if (existingAdmin) {
      existingAdmin.role = 'superadmin';
      await existingAdmin.save();
    } else {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await User.create({ username: 'admin', password: hashedPassword, role: 'superadmin' });
      logInfo("Super Admin Created -> admin : admin123");
    }
    app.listen(PORT, () => logInfo(`Server running on port ${PORT}`));
  });
});