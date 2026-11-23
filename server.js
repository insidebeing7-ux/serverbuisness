const AI_URL = process.env.AI_SERVICE_URL; // e.g. https://relay-ai.onrender.com
const AI_KEY = process.env.AI_SERVICE_KEY;
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PYTHON = process.env.PYTHON_BIN || 'python3';
const AI_SCRIPT = path.join(__dirname, 'aibusinessai.py'); // rename here if your file has another name
const MAX_KNOWLEDGE_CHARS = 30000; // how much file text is sent to the AI
const AI_TIMEOUT_MS = 90000;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }
});

// Serves the front end from /public
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('ok'));

// Turn an uploaded file into plain text for the AI
async function fileToText(file) {
  const name = file.originalname.toLowerCase();
  try {
    if (/\.(txt|md|csv|json)$/.test(name)) return file.buffer.toString('utf8');
    if (name.endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      return (await pdfParse(file.buffer)).text;
    }
  } catch (err) {
    console.error('Could not read', file.originalname, err.message);
  }
  return ''; // other types (docx, xlsx...) are skipped for now
}

// The front end posts here: phone, prompt and files
app.post('/api/call', upload.array('files', 5), async (req, res) => {
  const phone = String(req.body.phone || '').trim();
  const prompt = String(req.body.prompt || '').trim();

  if (!/^\+\d{1,3}\s?\d{6,14}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number.' });
  }
  if (!prompt || prompt.length > 2000) {
    return res.status(400).json({ error: 'The prompt is required (max 2000 characters).' });
  }

  // Build the knowledge text from the uploaded files
  let knowledge = '';
  for (const file of req.files || []) {
    const text = await fileToText(file);
    if (text) knowledge += `--- FILE: ${file.originalname} ---\n${text}\n\n`;
  }
  knowledge = knowledge.slice(0, MAX_KNOWLEDGE_CHARS);

    const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  try {
    const aiRes = await fetch(`${AI_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AI_KEY },
      body: JSON.stringify({ phone, prompt, knowledge }),
      signal: controller.signal
    });
    if (!aiRes.ok || !aiRes.body) {
      return res.status(502).json({ error: 'The AI request failed.' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    for await (const chunk of aiRes.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error('AI service error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'The AI request failed.' });
    else res.end('\n\n[The AI stopped unexpectedly.]');
  } finally {
    clearTimeout(timer);
  }

// Upload or other request errors
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
