// Dependencies
const proxy = require('http-proxy');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const zlib = require('zlib');
const { URL } = require('url');

// Manual constants
const ALLOWED_METHODS = http.METHODS;
const ALLOWED_PROTOS = ['http', 'https'];
const ALLOWED_GZIP_METHODS = ['transform', 'decode', 'append'];
const DEFAULT_PROTO = 'https';
const DEFAULT_USERAGENT = 'Mozilla';

const getHosts = (hosts) => {
  if (!hosts) {
    return [];
  }
  let parsed = [];
  hosts = hosts.split(',');
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    try {
      (() => new URL(`${DEFAULT_PROTO}://${host}`))();
    } catch (e) {
      throw new Error(`Configuration error! Invalid host domain on item ${host}`);
    }
    parsed.push({
      host: host
    });
  }
  return parsed;
};

// Environment Constants
const PORT = process.env.PORT || 80;
const ACCESS_KEY = process.env.ACCESS_KEY && Buffer.from(process.env.ACCESS_KEY);
const USE_WHITELIST = process.env.USE_WHITELIST === 'true';
const USE_OVERRIDE_STATUS = process.env.USE_OVERRIDE_STATUS === 'true';
const REWRITE_ACCEPT_ENCODING = process.env.REWRITE_ACCEPT_ENCODING === 'true';
const APPEND_HEAD = process.env.APPEND_HEAD === 'true';
const ALLOWED_HOSTS = getHosts(process.env.ALLOWED_HOSTS);
const GZIP_METHOD = process.env.GZIP_METHOD;

assert.ok(ACCESS_KEY, 'Missing ACCESS_KEY');
assert.ok(ALLOWED_GZIP_METHODS.includes(GZIP_METHOD), `GZIP_METHOD must be one of the following values: ${JSON.stringify(ALLOWED_GZIP_METHODS)}`);

const server = http.createServer();

const httpsProxy = proxy.createProxyServer({
  agent: new https.Agent({
    checkServerIdentity: (host, cert) => {
      return undefined;
    }
  }),
  changeOrigin: true
});

const httpProxy = proxy.createProxyServer({
  changeOrigin: true
});

const writeErr = (res, status, message) => {
  res.writeHead(status, {'Content-Type': 'text/plain'});
  res.end(message);
};

const onProxyError = (err, req, res) => {
  console.error(err);

  writeErr(res, 500, 'Proxying failed');
};

const appendHead = (proxyRes, res, append) => {
  const encoding = proxyRes.headers['content-encoding'];
  let handler;
  let encoder;
  let appendEncoded;
  switch (encoding) {
    case 'gzip':
      handler = zlib.gzip;
      break;
    default:
      appendEncoded = append;
  }
  if (handler) {
    encoder = new Promise((resolve, reject) => {
      handler(append, (e, buf) => {
        if (e) {
          reject(e);
        }
        appendEncoded = buf;
        resolve();
      });
    });
  }
  if ('content-length' in proxyRes.headers) {
    delete proxyRes.headers['content-length'];
  }
  const _end = res.end;
  res.end = async () => {
    if (!appendEncoded) {
      try {
        await encoder;
      } catch (e) {
        console.error(`Encoder error: ${e}`);
        return;
      }
    }
    res.write(appendEncoded);
    _end.call(res);
  };
};

const transformEncoded = (proxyRes, res, append) => {
  const encoding = proxyRes.headers['content-encoding'];
  let decodeHandler;
  let encodeHandler;
  let encoder;
  let decoder;
  switch (encoding) {
    case 'gzip':
      decodeHandler = zlib.createGunzip;
      encodeHandler = zlib.createGzip;
      break;
  }
  if (decodeHandler) {
    decoder = decodeHandler();
    encoder = encodeHandler();
    const _write = res.write.bind(res);
    const _end = res.end.bind(res);
    res.write = (chunk) => {
      decoder.write(chunk);
    };
    res.end = () => {
      decoder.end();
    };
    if (GZIP_METHOD === 'transform') {
      decoder.on('end', () => {
        encoder.write(append);
        encoder.end();
      });
      decoder.pipe(encoder, {end: false});
      encoder.on('data', (chunk) => {
        _write(chunk);
      });
      encoder.on('end', () => {
        _end();
      });
    } else if (GZIP_METHOD === 'decode') {
      decoder.on('data', (chunk) => {
        _write(chunk);
      });
      decoder.on('end', () => {
        _write(append);
        _end();
      });
      if ('content-encoding' in proxyRes.headers) {
        delete proxyRes.headers['content-encoding'];
      }
    }
  }
  if ('content-length' in proxyRes.headers) {
    delete proxyRes.headers['content-length'];
  }
};

const hostIsAllowed = (host) => {
  if (!USE_WHITELIST) return true;
  
  for (let i = 0; i < ALLOWED_HOSTS.length; i++) {
    if (host === ALLOWED_HOSTS[i].host) {
      return true;
    }
  }
  return false;
};

const processBatchItem = (requestItem, accessKey) => {
  return new Promise((resolve) => {
    const { requestId, url } = requestItem;
    
    // Create mock request and response objects
    const mockReq = new http.IncomingMessage(null);
    const mockRes = new http.ServerResponse({});
    
    // Parse the URL to get host and path
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      resolve({
        requestId,
        error: 'Invalid URL',
        status: 400
      });
      return;
    }
    
    // Set up the mock request
    mockReq.method = requestItem.method || 'GET';
    mockReq.headers = {
      'proxy-access-key': accessKey,
      'proxy-target': parsedUrl.host
    };
    
    // Override method if needed
    if (requestItem.method && requestItem.method !== 'GET' && requestItem.method !== 'POST') {
      mockReq.headers['proxy-target-override-method'] = requestItem.method;
    }
    
    // Override protocol if needed
    if (requestItem.proto) {
      mockReq.headers['proxy-target-override-proto'] = requestItem.proto;
    }
    
    // Add custom headers if provided
    if (requestItem.headers) {
      Object.keys(requestItem.headers).forEach(key => {
        mockReq.headers[key] = requestItem.headers[key];
      });
    }
    
    // Capture the response
    let responseData = Buffer.alloc(0);
    
    // Override the write and end methods to capture data
    mockRes.write = (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        responseData = Buffer.concat([responseData, chunk]);
      } else {
        responseData = Buffer.concat([responseData, Buffer.from(chunk)]);
      }
      return true;
    };
    
    // Handle response completion
    mockRes.end = (chunk) => {
      if (chunk) {
        mockRes.write(chunk);
      }
      
      // Try to parse response as per current format
      let result;
      try {
        const responseText = responseData.toString();
        const match = responseText.match(/(.*)"""(.+)"""$/s);
        
        if (match) {
          const responseBody = match[1];
          const metaData = JSON.parse(match[2]);
          
          result = {
            requestId,
            status: metaData.status.code,
            headers: metaData.headers,
            body: responseBody
          };
        } else {
          // No metadata found, return raw response
          result = {
            requestId,
            status: mockRes.statusCode,
            body: responseText
          };
        }
      } catch (e) {
        result = {
          requestId,
          error: 'Error processing response',
          status: 500
        };
      }
      
      resolve(result);
    };
    
    // Handle potential errors
    mockReq.on('error', (err) => {
      resolve({
        requestId,
        error: `Request error: ${err.message}`,
        status: 500
      });
    });
    
    // Process the request using existing proxy logic
    try {
      if (hostIsAllowed(parsedUrl.host)) {
        const proto = requestItem.proto || DEFAULT_PROTO;
        doProxy({host: parsedUrl.host}, proto, mockReq, mockRes);
      } else {
        resolve({
          requestId,
          error: 'Host not whitelisted',
          status: 400
        });
      }
    } catch (err) {
      resolve({
        requestId,
        error: `Proxy error: ${err.message}`,
        status: 500
      });
    }
  });
};

const handleBatchRequest = async (req, res) => {
  // Check for access key
  const accessKey = req.headers['proxy-access-key'];
  if (!accessKey) {
    writeErr(res, 400, 'proxy-access-key header is required');
    return;
  }
  
  // Verify access key
  const accessKeyBuffer = Buffer.from(accessKey);
  if (accessKeyBuffer.length !== ACCESS_KEY.length || 
      !crypto.timingSafeEqual(accessKeyBuffer, ACCESS_KEY)) {
    writeErr(res, 403, 'Invalid access key');
    return;
  }
  
  // Parse request body to get batch items
  let batchItems = [];
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    batchItems = JSON.parse(body);
  } catch (e) {
    writeErr(res, 400, 'Invalid batch request format');
    return;
  }
  
  // Validate batch format
  if (!Array.isArray(batchItems) || batchItems.length === 0) {
    writeErr(res, 400, 'Batch must be a non-empty array');
    return;
  }
  
  // Process all batch items in parallel
  const results = await Promise.all(
    batchItems.map(item => processBatchItem(item, accessKey))
  );
  
  // Transform results into requested format: { requestId: response }
  const formattedResults = {};
  results.forEach(result => {
    formattedResults[result.requestId] = {
      status: result.status,
      headers: result.headers || {},
      body: result.body || '',
      error: result.error || null
    };
  });
  
  // Return the results
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(formattedResults));
};

const processResponse = (proxyRes, res, append) => {
  if (['transform', 'decode'].includes(GZIP_METHOD) && proxyRes.headers['content-encoding']) {
    transformEncoded(proxyRes, res, append);
  } else {
    appendHead(proxyRes, res, append);
  }
};

const onProxyReq = (proxyReq, req, res, options) => {
  proxyReq.setHeader('User-Agent', proxyReq.getHeader('proxy-override-user-agent') || DEFAULT_USERAGENT);
  if (REWRITE_ACCEPT_ENCODING) {
    proxyReq.setHeader('Accept-Encoding', 'gzip');
  }
  proxyReq.removeHeader('roblox-id');
  proxyReq.removeHeader('proxy-access-key');
  proxyReq.removeHeader('proxy-target');
};

const onProxyRes = (proxyRes, req, res) => {
  const head = {
    headers: Object.assign({}, proxyRes.headers),
    status: {
      code: proxyRes.statusCode,
      message: proxyRes.statusMessage
    }
  };
  if (USE_OVERRIDE_STATUS) {
    proxyRes.statusCode = 200;
  }
  if (APPEND_HEAD) {
    const append = `"""${JSON.stringify(head)}"""`;
    processResponse(proxyRes, res, append);
  }
};

httpsProxy.on('error', onProxyError);
httpsProxy.on('proxyReq', onProxyReq);
httpsProxy.on('proxyRes', onProxyRes);

httpProxy.on('error', onProxyError);
httpProxy.on('proxyReq', onProxyReq);
httpProxy.on('proxyRes', onProxyRes);

const doProxy = (target, proto, req, res) => {
  var options = {
    target: proto + '://' + target.host
  };
  if (proto === 'https') {
    httpsProxy.web(req, res, options);
  } else if (proto === 'http') {
    httpProxy.web(req, res, options);
  } else {
    throw new Error(`Do proxy error: Unsupported protocol ${proto}`);
  }
};

server.on('request', (req, res) => {
  if (req.method === 'POST' && req.url === '/batch') {
    handleBatchRequest(req, res);
    return;
  }

  const method = req.headers['proxy-target-override-method'];
  if (method) {
    if (ALLOWED_METHODS.includes(method)) {
      req.method = method;
    } else {
      writeErr(res, 400, 'Invalid target method');
      return;
    }
  }
  const overrideProto = req.headers['proxy-target-override-proto'];
  if (overrideProto && !ALLOWED_PROTOS.includes(overrideProto)) {
    writeErr(res, 400, 'Invalid target protocol');
    return;
  }
  const accessKey = req.headers['proxy-access-key'];
  const requestedTarget = req.headers['proxy-target'];
  if (accessKey && requestedTarget) {
    req.on('error', (err) => {
      console.error(`Request error: ${err}`);
    });
    const accessKeyBuffer = Buffer.from(accessKey);
    if (accessKeyBuffer.length === ACCESS_KEY.length && crypto.timingSafeEqual(accessKeyBuffer, ACCESS_KEY)) {
      let parsedTarget;
      try {
        parsedTarget = new URL(`https://${requestedTarget}`);
      } catch (e) {
        writeErr(res, 400, 'Invalid target');
        return;
      }
      const requestedHost = parsedTarget.host;
      let hostAllowed = false;
      let hostProto = DEFAULT_PROTO;
      for (let i = 0; i < ALLOWED_HOSTS.length; i++) {
        const iHost = ALLOWED_HOSTS[i];
        if (requestedHost === iHost.host) {
          hostAllowed = true;
          break;
        }
      }
      if (!USE_WHITELIST) {
        hostAllowed = true;
      }
      if (overrideProto) {
        hostProto = overrideProto;
      }
      if (hostAllowed) {
        doProxy(parsedTarget, hostProto, req, res);
      } else {
        writeErr(res, 400, 'Host not whitelisted');
      }
    } else {
      writeErr(res, 403, 'Invalid access key');
    }
  } else {
    writeErr(res, 400, 'proxy-access-key and proxy-target headers are both required');
  }
});

server.listen(PORT, (err) => {
  if (err) {
    console.error(`Server listening error: ${err}`);
    return;
  }
  console.log(`Server started on port ${PORT}`);
});
