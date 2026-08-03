import { defineConfig } from 'vite';
import { resolve, sep } from 'node:path';
import { writeFileSync } from 'node:fs';

const BRAIN_ROOT = resolve(__dirname, '..');

export default defineConfig({
  server: {
    open: true,
    port: 5174,
  },
  plugins: [
    {
      name: 'brain-edit-api',
      configureServer(server) {
        server.middlewares.use('/api/save', (req, res, next) => {
          if (req.method !== 'POST') return next();
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            try {
              const { filePath, content } = JSON.parse(body);
              if (typeof filePath !== 'string' || typeof content !== 'string') {
                throw new Error('filePath and content (string) required');
              }
              const fullPath = resolve(BRAIN_ROOT, filePath);
              // Reject any path that escapes the brain root.
              if (!fullPath.startsWith(BRAIN_ROOT + sep) && fullPath !== BRAIN_ROOT) {
                throw new Error('path outside brain root');
              }
              writeFileSync(fullPath, content, 'utf-8');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, filePath }));
            } catch (err: any) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
        });
      },
    },
  ],
});
