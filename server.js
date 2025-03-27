// batch-proxy-forgiving.js
// Proxy server that processes batch requests and catches ALL errors,
// so that a proxy error is recorded for that item but does not crash the process.

require('dotenv').config();
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Construct the proxy URL using Anyip.io proxy details
const proxyUsername = 'user_8543bc,type_residential';
const proxyPassword = '8cfbeb';
const proxyHost     = 'portal.anyip.io';
const proxyPort     = '1080';
const proxyUrl = `http://${proxyUsername}:${proxyPassword}@${proxyHost}:${proxyPort}`;

// Optional: use API_LINK from environment if needed
const API_LINK = process.env.API_LINK;

// Enable keep-alive to reduce connection overhead
const proxyAgentOptions = {
  keepAlive: true,
  maxSockets: 50
};

const httpAgent = new HttpProxyAgent(proxyUrl, proxyAgentOptions);
const httpsAgent = new HttpsProxyAgent(proxyUrl, proxyAgentOptions);

// Access key configuration
const ACCESS_KEY = '301986304d6e36b426a31b70e47684d3a79363a1b6252cab0716d3a7fc7147d1';
const ACCESS_KEY_BUFFER = Buffer.from(ACCESS_KEY);

// Use a Heroku-provided port or default to 3000
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, proxy-access-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
    return;
  }

  if (req.method === 'POST' && req.url === '/batch') {
    handleBatchRequest(req, res);
  } else {
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('Not Found - This server only supports batch requests to /batch');
  }
});

async function handleBatchRequest(req, res) {
  console.log('Received batch request');

  // Verify access key
  const accessKey = req.headers['proxy-access-key'];
  if (!accessKey) {
    sendError(res, 400, 'Missing proxy-access-key header');
    return;
  }

  try {
    const accessKeyBuffer = Buffer.from(accessKey);
    if (accessKeyBuffer.length !== ACCESS_KEY_BUFFER.length ||
        !crypto.timingSafeEqual(accessKeyBuffer, ACCESS_KEY_BUFFER)) {
      sendError(res, 403, 'Invalid access key');
      return;
    }
  } catch (err) {
    console.error('Access key validation error:', err);
    sendError(res, 500, 'Server error during authentication');
    return;
  }

  // Parse request body
  let batchItems = [];
  try {
    batchItems = await parseRequestBody(req);
    if (!Array.isArray(batchItems) || batchItems.length === 0) {
      sendError(res, 400, 'Request body must be a non-empty array');
      return;
    }
  } catch (err) {
    console.error('Error parsing request body:', err);
    sendError(res, 400, 'Invalid request format: ' + err.message);
    return;
  }

  console.log(`Processing ${batchItems.length} batch items (forgiving errors)`);

  try {
    // Process items with a concurrency limit; errors are recorded per item
    const results = await processBatchWithLimit(batchItems, 50);

    // Format the results by requestId
    const formattedResults = {};
    results.forEach(result => {
      formattedResults[result.requestId] = {
        status: result.status,
        headers: result.headers || {},
        body: result.body || '',
        error: result.error || null
      };
    });

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(formattedResults));
  } catch (err) {
    console.error('Error processing batch:', err);
    sendError(res, 500, 'Server error processing batch');
  }
}

// Process batch items with a concurrency limit
async function processBatchWithLimit(batchItems, maxConcurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < batchItems.length) {
      const currentIndex = index++;
      const item = batchItems[currentIndex];
      // Each item is processed; any error is caught inside processBatchItem
      const result = await processBatchItem(item);
      results[currentIndex] = result;
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(maxConcurrency, batchItems.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// Process a single item; all errors are caught and result in a resolved error object.
function processBatchItem(item) {
  return new Promise((resolve) => {
    try {
      const { requestId, url } = item;

      if (!requestId) {
        return resolve({
          requestId: 'unknown',
          error: 'Missing requestId field',
          status: 400
        });
      }

      if (!url) {
        return resolve({
          requestId,
          error: 'Missing url field',
          status: 400
        });
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return resolve({
          requestId,
          error: 'Invalid URL: ' + e.message,
          status: 400
        });
      }

      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: item.method || 'GET',
        headers: {
          'User-Agent': 'RobloxBatchProxy/1.0',
          'Accept': '*/*'
        },
        agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent
      };

      console.log(`Proxying request to ${parsedUrl.host}${parsedUrl.pathname}`);

      const proxyReq = protocol.request(options, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (chunk) => {
          try {
            chunks.push(chunk);
          } catch (e) {
            console.error("Error in data event:", e);
          }
        });
        proxyRes.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString();
            let finalBody = body;
            if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
              try {
                const parsedBody = JSON.parse(body);
                if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
                  parsedBody.requestKey = requestId;
                  finalBody = parsedBody;
                }
              } catch (e) {
                // Non-JSON body; ignore
              }
            }
            resolve({
              requestId,
              status: proxyRes.statusCode,
              headers: proxyRes.headers,
              body: finalBody
            });
          } catch (e) {
            console.error("Error processing response:", e);
            resolve({
              requestId,
              error: "Error processing response: " + e.message,
              status: 500
            });
          }
        });
      });

      // Catch errors on the request
      proxyReq.on('error', (err) => {
        try {
          console.error(`Error proxying to ${url}:`, err);
        } catch (e) {
          console.error(e);
        }
        resolve({
          requestId,
          error: `Proxy error: ${err.message}`,
          status: 502
        });
      });

      // Attach error handler to the underlying socket as well
      proxyReq.on('socket', (socket) => {
        socket.on('error', (err) => {
          console.error(`Socket error for ${url}:`, err);
          // Do not resolve here; the proxyReq 'error' handler will catch it.
        });
      });

      // Set a shorter timeout to avoid long waits
      proxyReq.setTimeout(5000, () => {
        proxyReq.destroy();
        resolve({
          requestId,
          error: 'Request timeout',
          status: 504
        });
      });

      proxyReq.end();
    } catch (ex) {
      console.error("Caught in processBatchItem outer try-catch:", ex);
      resolve({
        requestId: item.requestId || 'unknown',
        error: "Caught exception: " + ex.message,
        status: 500
      });
    }
  });
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        reject(new Error('Empty request body'));
        return;
      }
      try {
        const body = Buffer.concat(chunks).toString();
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (err) {
        reject(new Error('Invalid JSON: ' + err.message));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function sendError(res, status, message) {
  res.writeHead(status, {'Content-Type': 'text/plain'});
  res.end(message);
}

server.listen(PORT, () => {
  console.log(`Batch proxy server (forgiving errors) running on port ${PORT}`);
});

// Catch-all global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection: ', reason);
});