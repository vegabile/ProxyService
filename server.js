// batch-proxy-unlimited.js
// Proxy server without request rate limiting (allows unlimited requests)

require('dotenv').config();
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// 1. Construct the proxy URL using Anyip.io proxy server details
const proxyUsername = 'user_8543bc,type_residential';
const proxyPassword = '8cfbeb';
const proxyHost     = 'portal.anyip.io';
const proxyPort     = '1080';

// Format the proxy URL (HTTP scheme, even for HTTPS requests)
const proxyUrl = `http://${proxyUsername}:${proxyPassword}@${proxyHost}:${proxyPort}`;

// Optional: if you need an API_LINK from environment, else leave it as is.
const API_LINK = process.env.API_LINK;

// Create proxy agents
const httpAgent = new HttpProxyAgent(proxyUrl);
const httpsAgent = new HttpsProxyAgent(proxyUrl);

// Retry configuration remains unchanged for handling 429 responses
const MAX_RETRIES = 3;              // Retry up to 3 times on 429 responses
const RETRY_DELAY_BASE = 200;       // Base delay for retries (exponential backoff)

// Define the expected access key and create a buffer from it
const ACCESS_KEY = '301986304d6e36b426a31b70e47684d3a79363a1b6252cab0716d3a7fc7147d1';
const ACCESS_KEY_BUFFER = Buffer.from(ACCESS_KEY);

// Define PORT variable for Heroku dynamic port assignment (or default to 3000)
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer((req, res) => {
  // Add CORS headers for development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, proxy-access-key');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
    return;
  }
  
  // Only handle POST requests to /batch
  if (req.method === 'POST' && req.url === '/batch') {
    handleBatchRequest(req, res);
  } else {
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('Not Found - This server only supports batch requests to /batch');
  }
});

// Handle batch requests
async function handleBatchRequest(req, res) {
  console.log('Received batch request');
  
  // Verify access key
  const accessKey = req.headers['proxy-access-key'];
  if (!accessKey) {
    sendError(res, 400, 'Missing proxy-access-key header');
    return;
  }
  
  // Compare access keys securely
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
  
  console.log(`Processing ${batchItems.length} batch items without rate limiting`);
  
  // Process all requests concurrently without throttling using Promise.allSettled to capture errors individually
  try {
    const results = await processBatch(batchItems);
    
    // Format results by requestId
    const formattedResults = {};
    results.forEach(result => {
      formattedResults[result.requestId] = {
        status: result.status,
        headers: result.headers || {},
        body: result.body || '',
        error: result.error || null
      };
    });
    
    // Send response
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(formattedResults));
    
  } catch (err) {
    console.error('Error processing batch:', err);
    sendError(res, 500, 'Server error processing batch');
  }
}

// Process batch concurrently using Promise.allSettled so one error won't crash the entire process
async function processBatch(batchItems) {
  const settledResults = await Promise.allSettled(
    batchItems.map(item => processBatchItemWithRetry(item))
  );
  // Convert settled promises into results
  return settledResults.map(result => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      // If an unexpected error occurred, return a generic error object.
      return {
        requestId: 'unknown',
        error: `Unhandled error: ${result.reason}`,
        status: 500
      };
    }
  });
}

// Process a batch item with retry logic for rate limiting (retry logic remains intact)
async function processBatchItemWithRetry(item, attempt = 1) {
  try {
    const result = await processBatchItem(item);
    
    // If we got a 429 (Too Many Requests) status, retry with backoff
    if (result.status === 429 && attempt <= MAX_RETRIES) {
      // Exponential backoff
      const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
      console.log(`Rate limited for ${item.requestId}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return processBatchItemWithRetry(item, attempt + 1);
    }
    
    return result;
  } catch (err) {
    return {
      requestId: item.requestId,
      error: `Processing error: ${err.message}`,
      status: 500
    };
  }
}

// Parse the request body
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    req.on('data', chunk => {
      chunks.push(chunk);
    });
    
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
    
    req.on('error', err => {
      reject(err);
    });
  });
}

// Process a single item in the batch
function processBatchItem(item) {
  return new Promise((resolve) => {
    // Validate required fields
    const { requestId, url } = item;
    
    if (!requestId) {
      resolve({
        requestId: item.requestId || 'unknown',
        error: 'Missing requestId field',
        status: 400
      });
      return;
    }
    
    if (!url) {
      resolve({
        requestId,
        error: 'Missing url field',
        status: 400
      });
      return;
    }
    
    // Parse URL
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      resolve({
        requestId,
        error: 'Invalid URL: ' + e.message,
        status: 400
      });
      return;
    }
    
    // Choose protocol module based on the URL protocol
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    // Setup request options
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
    
    // Add custom headers if provided
    if (item.headers) {
      Object.assign(options.headers, item.headers);
    }
    
    console.log(`Proxying request to ${parsedUrl.host}${parsedUrl.pathname}`);
    
    // Make the request
    const proxyReq = protocol.request(options, (proxyRes) => {
      const chunks = [];
      
      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let finalBody = body;
        
        // If the proxied request is successful, try to add the "requestKey" field
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          try {
            const parsedBody = JSON.parse(body);
            if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
              parsedBody.requestKey = requestId;
              finalBody = parsedBody;
            }
          } catch (e) {
            // If the body is not JSON, leave it as is
          }
        }
        
        resolve({
          requestId,
          status: proxyRes.statusCode,
          headers: proxyRes.headers,
          body: finalBody
        });
      });
    });
    
    // Handle request errors
    proxyReq.on('error', (err) => {
      console.error(`Error proxying to ${url}:`, err);
      resolve({
        requestId,
        error: `Proxy error: ${err.message}`,
        status: 502
      });
    });
    
    // Set timeout for the proxy request
    proxyReq.setTimeout(10000, () => {
      proxyReq.destroy();
      resolve({
        requestId,
        error: 'Request timeout',
        status: 504
      });
    });
    
    // End the request (important for POST/PUT)
    proxyReq.end();
  });
}

// Send error response
function sendError(res, status, message) {
  res.writeHead(status, {'Content-Type': 'text/plain'});
  res.end(message);
}

// Start the server
server.listen(PORT, () => {
  console.log(`Batch proxy server (unlimited requests) running on port ${PORT}`);
});

// Handle process errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Optionally, you can add logic to restart or log more details here.
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection:', reason);
  // Optionally, add further error handling here.
});