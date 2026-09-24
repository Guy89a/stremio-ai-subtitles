'use strict';

// Entry point on Render (render.yaml: node src/boot.js). Installs the Gemini
// fetch wrapper - retries, Flash → Flash-Lite fallback, settings workarounds -
// and then starts the server.
require('./gemini-fetch').install();
require('./server.js');
