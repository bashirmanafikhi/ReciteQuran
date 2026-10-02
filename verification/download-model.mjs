import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_URL =
  'https://github.com/Iam-Muslim/Natlu/releases/download/models-latest/zipformer_p_arabic_v3.int8.onnx';
const MODEL_FILENAME = 'zipformer_p_arabic_v3.int8.onnx';

const targetDir = path.resolve(__dirname, '../assets/model');
const targetFile = path.join(targetDir, MODEL_FILENAME);
const tempFile = `${targetFile}.tmp`;

async function download(url, dest) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  if (fs.existsSync(targetFile) && fs.statSync(targetFile).size > 1024 * 1024) {
    console.log(`Model already exists at: ${targetFile}`);
    return;
  }

  console.log(`Downloading ${url} -> ${targetFile}`);

  return new Promise((resolve, reject) => {
    function get(currentUrl, redirects = 0) {
      if (redirects > 10) {
        return reject(new Error('Too many redirects'));
      }

      const client = currentUrl.startsWith('https') ? https : http;
      client.get(currentUrl, (res) => {
        if (
          res.statusCode === 301 ||
          res.statusCode === 302 ||
          res.statusCode === 307 ||
          res.statusCode === 308
        ) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) return reject(new Error('Redirect with no location header'));
          return get(redirectUrl, redirects + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed with status code ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let receivedBytes = 0;
        const fileStream = fs.createWriteStream(tempFile);

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = ((receivedBytes / totalBytes) * 100).toFixed(1);
            const mbRec = (receivedBytes / (1024 * 1024)).toFixed(1);
            const mbTot = (totalBytes / (1024 * 1024)).toFixed(1);
            process.stdout.write(`\r[Download] ${pct}% (${mbRec} MB / ${mbTot} MB)`);
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => {
            console.log('\nDownload complete. Renaming temp file...');
            if (fs.existsSync(targetFile)) {
              fs.unlinkSync(targetFile);
            }
            fs.renameSync(tempFile, targetFile);
            console.log(`Model successfully saved to ${targetFile}`);
            resolve();
          });
        });

        fileStream.on('error', (err) => {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
          reject(err);
        });
      }).on('error', (err) => {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        reject(err);
      });
    }

    get(url);
  });
}

download(MODEL_URL, targetFile).catch((err) => {
  console.error('Download error:', err);
  process.exit(1);
});
