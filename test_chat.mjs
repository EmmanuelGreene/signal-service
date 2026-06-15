import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/signals', (req, res) => res.json({ok:true}));
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  try {
    const result = execSync(
      'cd /opt/hermes && HERMES_HOME=/opt/data uv run --no-sync python -m hermes_cli.main -Q chat -q ' + JSON.stringify(message) + ' 2>/dev/null',
      { timeout: 30000, encoding: 'utf-8', maxBuffer: 50 * 1024 }
    );
    const reply = result.replace(/\nsession_id:.*$/, '').trim();
    res.json({ success: true, reply });
  } catch (e) {
    res.json({ success: true, reply: 'Fallback: ' + e.message.slice(0, 100), fallback: true });
  }
});
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

app.listen(5155, () => console.log('Test on 5155'));
