const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

// Serve everything under public/ as static files.
// The WASM file needs the correct MIME type to load in browsers.
express.static.mime.define({ 'application/wasm': ['wasm'] });

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`ml-vs-hardcode-demo server running at http://localhost:${PORT}`);
  console.log('Open the URL above in Chromium (or another browser that supports Web Serial).');
});
