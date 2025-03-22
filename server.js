// simple-batch-proxy.js
// A minimal proxy server that only handles batch requests

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

// Configuration - set these as environment variables
const PORT = process.env.PORT || 3000;
const ACCESS_KEY = process.env.ACCESS_KEY || 'your-access-key-here'; // Change this!
const ACCESS_KEY_BUFFER = Buffer.from(ACCESS_KEY);

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
  
  // Compare access keys
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
  
  console.log(`Processing ${batchItems.length} batch items`);
  
  // Process all requests in parallel
  try {
    const results = await Promise.all(
      batchItems.map(item => processBatchItem(item))
    );
    
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
    
    // Choose protocol module
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
      }
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
        
        resolve({
          requestId,
          status: proxyRes.statusCode,
          headers: proxyRes.headers,
          body: body
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
    
    // Set timeout
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
  console.log(`Batch proxy server running on port ${PORT}`);
});

// Handle process errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Keep the server running despite errors
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection:', reason);
  // Keep the server running despite errors
});