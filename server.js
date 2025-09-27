const express = require('express');
const path = require('path');
const redis = require('redis');
const app = express();
const PORT = 9000;

// Redis client setup
const redisClient = redis.createClient({
  host: 'localhost',
  port: 6379
});

redisClient.on('error', (err) => {
  console.log('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('✅ Connected to Redis');
});

// Connect to Redis
redisClient.connect().catch(err => {
  console.log('Failed to connect to Redis:', err);
});

// Store for payment requests
const paymentRequests = [];
const requestPairs = []; // Store pairs of requests for comparison
const pendingRequestsByRequestId = new Map(); // Store requests waiting for their pair by x-request-id

// Temporary storage for all messages (for analysis)
const allMessages = [];

// Async polling function for non-blocking response waiting
async function startAsyncPolling(requestId, res) {
  let attempts = 0;
  const maxAttempts = 5; // 5 seconds / 1 second intervals
  
  console.log(`🔄 Starting async polling for ${requestId} (checking every 1s for 5s)`);
  
  const pollInterval = setInterval(async () => {
    attempts++;
    console.log(`🔍 Polling attempt ${attempts}/5 for ${requestId}`);
    
    try {
      // Check Redis for response
      const responseData = await getRequestResponseFromRedis(requestId);
      if (responseData && responseData.hsResponse) {
        clearInterval(pollInterval);
        
        // Validate x-request-id
        const responseXRequestId = responseData.hsResponse.headers['x-request-id'];
        if (responseXRequestId === requestId) {
          console.log(`✅ Response found and validated for ${requestId} after ${attempts}s`);
          return res.status(responseData.hsResponse.statusCode)
                    .set(responseData.hsResponse.headers)
                    .json(responseData.hsResponse.body);
        } else {
          console.log(`❌ x-request-id mismatch for ${requestId}`);
          return res.status(500).json({ 
            error: "Response x-request-id mismatch", 
            requestId, 
            responseId: responseXRequestId 
          });
        }
      }
      
      // Timeout after 5 attempts (5 seconds)
      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        console.log(`⏰ Polling timeout for ${requestId} after ${attempts} attempts`);
        return res.status(408).json({ 
          error: "Response timeout", 
          requestId,
          pollingAttempts: attempts 
        });
      }
    } catch (error) {
      clearInterval(pollInterval);
      console.log(`❌ Polling error for ${requestId}:`, error.message);
      return res.status(500).json({ 
        error: "Polling error", 
        requestId,
        details: error.message 
      });
    }
  }, 1000); // Check every 1 second
}

// Redis storage functions
async function storeRequestResponseInRedis(requestId, hsRequest, hsResponse) {
  try {
    const data = {
      requestId: requestId,
      timestamp: new Date().toISOString(),
      hsRequest: hsRequest,
      hsResponse: hsResponse,
      stored_at: Date.now()
    };
    
    await redisClient.setEx(`req:${requestId}`, 3600, JSON.stringify(data)); // Expire in 1 hour
    console.log(`💾 Stored request-response pair in Redis for ${requestId}`);
  } catch (error) {
    console.log(`❌ Redis storage error for ${requestId}:`, error.message);
  }
}

async function getRequestResponseFromRedis(requestId) {
  try {
    const data = await redisClient.get(`req:${requestId}`);
    if (data) {
      return JSON.parse(data);
    }
    return null;
  } catch (error) {
    console.log(`❌ Redis retrieval error for ${requestId}:`, error.message);
    return null;
  }
}

async function getAllStoredRequestsFromRedis() {
  try {
    const keys = await redisClient.keys('req:*');
    const results = [];
    
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) {
        results.push(JSON.parse(data));
      }
    }
    
    return results.sort((a, b) => b.stored_at - a.stored_at); // Latest first
  } catch (error) {
    console.log(`❌ Redis get all error:`, error.message);
    return [];
  }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text());
app.use(express.raw());

function detectMessageType(body, headers, method) {
  if (body && typeof body === 'object') {
    // Explicit type indicators
    if (body.type === 'request' || body.type === 'response') {
      return body.type.toUpperCase();
    }
    
    // Webhook/Event response indicators
    if (body.event_type || body.event_id || body.merchant_id) {
      return 'WEBHOOK/RESPONSE';
    }
    
    // Payment gateway request indicators
    if (body.createTransactionRequest || body.merchantAuthentication) {
      return 'PAYMENT REQUEST';
    }
    
    // General response indicators
    if (body.statusCode || body.status || body.responseCode || body.transactionResponse) {
      return 'RESPONSE';
    }
    
    // Request indicators
    if (body.method || body.url || body.endpoint || body.transactionRequest) {
      return 'REQUEST';
    }
    
    // Request-response pair
    if (body.request && body.response) {
      return 'REQUEST-RESPONSE PAIR';
    }
  }
  
  // Check headers
  const contentType = headers['content-type'] || '';
  const userAgent = headers['user-agent'] || '';
  
  if (contentType.includes('response') || headers['x-message-type'] === 'response') {
    return 'RESPONSE';
  }
  if (contentType.includes('request') || headers['x-message-type'] === 'request') {
    return 'REQUEST';
  }
  
  // User-agent based detection
  if (userAgent.includes('Backend-Server') || userAgent.includes('webhook')) {
    return 'WEBHOOK/RESPONSE';
  }
  
  return 'UNKNOWN';
}

function generateRequestId(body, headers) {
  // First try to get x-request-id from headers
  const xRequestId = headers['x-request-id'];
  if (xRequestId) {
    return xRequestId;
  }
  
  // Try to extract a unique identifier from the payment request
  if (body.createTransactionRequest?.refId) {
    return body.createTransactionRequest.refId;
  }
  if (body.createTransactionRequest?.transactionRequest?.order?.invoiceNumber) {
    return body.createTransactionRequest.transactionRequest.order.invoiceNumber;
  }
  // Fallback to timestamp-based ID
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function detectRequestSource(headers, messageType = null, body = null) {
  // For REQUEST-RESPONSE PAIR messages, this is always from HyperSwitch
  if (messageType === 'REQUEST-RESPONSE PAIR') {
    return 'HyperSwitch';
  }
  
  // Check x-source header to determine source
  const xSource = headers['x-source'];
  if (xSource) {
    return 'UCS'; // Has x-source header, so it's from UCS
  }
  return 'HyperSwitch'; // No x-source header, so it's from HyperSwitch
}

function createRequestPairByRequestId(newRequest) {
  const xRequestId = newRequest.headers['x-request-id'];
  
  if (!xRequestId) {
    console.log(`⚠️ Request ${newRequest.id} has no x-request-id, cannot pair (x-request-id required)`);
    return null;
  }
  
  // Check if we have a pending request with the same x-request-id
  if (pendingRequestsByRequestId.has(xRequestId)) {
    const existingRequest = pendingRequestsByRequestId.get(xRequestId);
    
    // Create a pair
    const pairId = `pair_${xRequestId}_${Date.now()}`;
    
    // Determine which is request1 and request2 based on source
    const ucsRequest = existingRequest.source === 'UCS' ? existingRequest : newRequest;
    const hyperSwitchRequest = existingRequest.source === 'HyperSwitch' ? existingRequest : newRequest;
    
    // Extract flow and connector information
    const xFlow = ucsRequest.headers['x-flow'] || hyperSwitchRequest.headers['x-flow'] || 'Unknown Flow';
    const xConnector = ucsRequest.headers['x-connector'] || hyperSwitchRequest.headers['x-connector'] || null;
    
    const pair = {
      id: pairId,
      request1: ucsRequest.source === 'UCS' ? ucsRequest : hyperSwitchRequest,
      request2: ucsRequest.source === 'UCS' ? hyperSwitchRequest : ucsRequest,
      xRequestId: xRequestId,
      xFlow: xFlow,
      xConnector: xConnector,
      createdAt: new Date().toISOString(),
      compared: false,
      sources: {
        request1: ucsRequest.source === 'UCS' ? 'UCS' : 'HyperSwitch',
        request2: ucsRequest.source === 'UCS' ? 'HyperSwitch' : 'UCS'
      }
    };
    
    // Mark both requests as paired
    existingRequest.paired = true;
    newRequest.paired = true;
    
    requestPairs.push(pair);
    pendingRequestsByRequestId.delete(xRequestId);
    
    console.log(`👥 Created request pair by x-request-id: ${pairId}`);
    console.log(`🌊 Flow: ${xFlow}`);
    console.log(`🔌 Connector: ${xConnector || 'Not specified'}`);
    console.log(`📊 UCS vs HyperSwitch: ${pair.sources.request1} vs ${pair.sources.request2}`);
    console.log(`📊 Total pairs: ${requestPairs.length}`);
    
    return pair;
  } else {
    // Store this request as pending
    pendingRequestsByRequestId.set(xRequestId, newRequest);
    console.log(`⏳ Request ${newRequest.id} stored as pending for x-request-id: ${xRequestId}`);
    return null;
  }
}

// Removed fallback pairing - only pair by x-request-id

app.all('/receive', async (req, res) => {
  const messageType = detectMessageType(req.body, req.headers, req.method);
  const typeEmoji = messageType === 'REQUEST' ? '📤' : 
                   messageType === 'RESPONSE' ? '📥' : 
                   messageType === 'PAYMENT REQUEST' ? '💳' :
                   messageType === 'WEBHOOK/RESPONSE' ? '🔔' :
                   messageType === 'REQUEST-RESPONSE PAIR' ? '🔄' : '❓';
  
  const timestamp = new Date().toISOString();
  const isHyperSwitch = req.headers.via === 'HyperSwitch';
  
  // Store messages for analysis (exclude UCS requests with response objects to avoid circular refs)
  if ((isHyperSwitch || messageType === 'REQUEST-RESPONSE PAIR') && 
      !(messageType === 'PAYMENT REQUEST' && req.headers['x-source'] === 'connector-service')) {
    allMessages.push({
      timestamp,
      type: messageType,
      headers: req.headers,
      body: req.body,
      method: req.method,
      url: req.url
    });
  }
  
  // Handle UCS requests - check Redis first, then async polling
  if (isHyperSwitch && messageType === 'PAYMENT REQUEST' && req.headers['x-source'] === 'connector-service') {
    const requestId = generateRequestId(req.body, req.headers);
    const xRequestId = req.headers['x-request-id'];
    
    console.log(`📨 UCS request received for ${xRequestId}`);
    console.log('\n' + '🔍 COMPLETE UCS REQUEST DATA:');
    console.log('='.repeat(60));
    console.log('📋 METHOD:', req.method);
    console.log('🌐 URL:', req.url);
    console.log('📅 TIMESTAMP:', timestamp);
    console.log('\n📤 HEADERS (Complete):');
    console.log(JSON.stringify(req.headers, null, 2));
    console.log('\n📦 BODY (Complete):');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('='.repeat(60) + '\n');
    
    // 1. Check Redis immediately for existing response
    try {
      const existingResponse = await getRequestResponseFromRedis(xRequestId);
      if (existingResponse && existingResponse.hsResponse) {
        console.log(`🚀 Found existing response in Redis for ${xRequestId}, sending immediately`);
        
        // Validate x-request-id
        const responseXRequestId = existingResponse.hsResponse.headers['x-request-id'];
        if (responseXRequestId === xRequestId) {
          return res.status(existingResponse.hsResponse.statusCode)
                    .set(existingResponse.hsResponse.headers)
                    .json(existingResponse.hsResponse.body);
        } else {
          console.log(`❌ Cached response x-request-id mismatch for ${xRequestId}`);
          return res.status(500).json({ 
            error: "Cached response x-request-id mismatch", 
            requestId: xRequestId,
            responseId: responseXRequestId 
          });
        }
      }
    } catch (error) {
      console.log(`⚠️ Redis check error for ${xRequestId}:`, error.message);
    }
    
    // 2. Store UCS request for pairing (simplified - no response object)
    const requestData = {
      id: requestId,
      timestamp,
      type: messageType,
      headers: req.headers,
      body: req.body,
      method: req.method,
      url: req.url,
      source: 'UCS',
      paired: false
    };
    
    paymentRequests.push(requestData);
    console.log(`📝 Stored UCS request, starting async polling for ${xRequestId}`);
    
    // 3. Start non-blocking async polling
    startAsyncPolling(xRequestId, res);
    return; // Non-blocking - polling handles response
  }
  
  // Store other HyperSwitch PAYMENT REQUEST messages 
  if (isHyperSwitch && messageType === 'PAYMENT REQUEST') {
    const requestId = generateRequestId(req.body, req.headers);
    const source = detectRequestSource(req.headers, messageType, req.body);
    
    const requestData = {
      id: requestId,
      timestamp,
      type: messageType,
      headers: req.headers,
      body: req.body,
      method: req.method,
      url: req.url,
      source: source,
      paired: false
    };
    
    paymentRequests.push(requestData);
    console.log(`📝 Stored ${source} payment request with ID: ${requestId}`);
    console.log(`📊 Total requests stored: ${paymentRequests.length}`);
    
    // Check for pairing: UCS request vs HyperSwitch request
    const xRequestId = req.headers['x-request-id'];
    if (xRequestId) {
      const matchingRequest = paymentRequests.find(r => 
        r.headers['x-request-id'] === xRequestId && 
        r.source !== source && 
        !r.paired
      );
      
      if (matchingRequest) {
        console.log(`🎯 Found matching request pair! Creating comparison...`);
        
        // Determine which is UCS vs HyperSwitch
        const ucsRequest = source === 'UCS' ? requestData : matchingRequest;
        const hsRequest = source === 'HyperSwitch' ? requestData : matchingRequest;
        
        const pairId = `pair_${xRequestId}`;
        const newPair = {
          id: pairId,
          xRequestId: xRequestId,
          timestamp: new Date().toISOString(),
          request1: ucsRequest,        // UCS request
          request2: hsRequest,         // HyperSwitch request
          xConnector: ucsRequest.headers['x-connector'] || hsRequest.headers['x-connector'] || 'unknown',
          xFlow: ucsRequest.headers['x-flow'] || hsRequest.headers['x-flow'] || 'unknown',
          compared: false,
          responseSent: false
        };
        
        requestPairs.push(newPair);
        ucsRequest.paired = true;
        hsRequest.paired = true;
        
        console.log(`✅ Pair created: ${pairId}`);
        console.log(`🔄 UCS Request vs HyperSwitch Request comparison ready`);
      } else {
        console.log(`⏳ Request ${requestId} stored as pending for x-request-id: ${xRequestId}`);
      }
    }
  }
  
  // NEW: Handle REQUEST-RESPONSE PAIR messages from mitmproxy
  if (messageType === 'REQUEST-RESPONSE PAIR') {
    try {
      // Extract x-request-id from the nested request headers (mitmproxy format)
      const xRequestId = req.body.request?.headers?.['x-request-id'];
      
      if (xRequestId) {
        console.log(`📥 Received REQUEST-RESPONSE PAIR for x-request-id: ${xRequestId}`);
        console.log(`🔍 Processing mitmproxy request-response data...`);
        
        // Parse the nested request body (JSON string) - handle BOM
        const hsRequest = JSON.parse(req.body.request.body);
        const responseBodyClean = req.body.response.body.replace(/^\uFEFF/, ''); // Remove BOM
        const hsResponse = JSON.parse(responseBodyClean);
        
        // Store clean request-response data in Redis
        await storeRequestResponseInRedis(xRequestId, {
          method: req.body.request.method,
          url: req.body.request.url,
          headers: req.body.request.headers,
          body: hsRequest
        }, {
          statusCode: req.body.response.status_code,
          headers: req.body.response.headers,
          body: hsResponse
        });
        
        // Find matching UCS request by x-request-id
        const matchingUCSRequest = paymentRequests.find(r => 
          r.headers['x-request-id'] === xRequestId && 
          r.source === 'UCS' && 
          !r.paired
        );
        
        if (matchingUCSRequest) {
          console.log(`🎯 Found matching UCS request! Creating comparison pair and sending response...`);
          
          // Create HyperSwitch request object from nested data with clean headers
          const originalHeaders = req.body.request.headers;
          const cleanHeaders = {
            'content-type': originalHeaders['content-type'],
            'content-length': originalHeaders['content-length'],
            'x-connector': originalHeaders['x-connector'],
            'x-flow': originalHeaders['x-flow'],
            'x-request-id': originalHeaders['x-request-id'],
            'via': originalHeaders['via']
          };
          
          const hsRequestData = {
            id: xRequestId,
            timestamp: timestamp,
            type: 'HYPERSWITCH_REQUEST',
            headers: cleanHeaders,  // Use only the relevant gateway headers
            body: hsRequest,
            method: req.body.request.method,
            url: req.body.request.url,
            source: 'HyperSwitch',
            paired: true
          };
          
          // Create comparison pair (UCS request vs HyperSwitch request)
          const pairId = `pair_${xRequestId}`;
          const newPair = {
            id: pairId,
            xRequestId: xRequestId,
            timestamp: new Date().toISOString(),
            request1: matchingUCSRequest,        // UCS request
            request2: hsRequestData,             // HyperSwitch request (from mitmproxy data)
            xConnector: req.body.request.headers['x-connector'] || matchingUCSRequest.headers['x-connector'],
            xFlow: req.body.request.headers['x-flow'] || matchingUCSRequest.headers['x-flow'],
            compared: false,
            responseSent: true,
            sources: {
              request1: 'UCS',
              request2: 'HyperSwitch'
            }
          };
          
          requestPairs.push(newPair);
          matchingUCSRequest.paired = true;
          
          console.log(`✅ Pair created: ${pairId} (UCS vs HyperSwitch request)`);
          
          // Store the HyperSwitch response
          matchingUCSRequest.responseData = {
            statusCode: req.body.response.status_code,
            headers: req.body.response.headers,
            body: hsResponse,
            sentAt: new Date().toISOString()
          };
          
          console.log(`📬 HyperSwitch response stored for UCS request: ${xRequestId}`);
          console.log(`📊 Response Status: ${req.body.response.status_code}`);
          
          // Extract transaction status if available
          if (hsResponse.transactionResponse) {
            const txnStatus = hsResponse.transactionResponse.responseCode === '1' ? 'APPROVED' : 'DECLINED';
            const txnId = hsResponse.transactionResponse.transId;
            console.log(`💳 Transaction Status: ${txnStatus}`);
            console.log(`🔑 Transaction ID: ${txnId || 'N/A'}`);
          }
          
          // Send response immediately to UCS if response object is available
          if (matchingUCSRequest.responseObject && !matchingUCSRequest.responseSent) {
            // Validate that response x-request-id matches UCS x-request-id
            const responseXRequestId = matchingUCSRequest.responseData.headers['x-request-id'];
            const ucsXRequestId = matchingUCSRequest.headers['x-request-id'];
            
            if (responseXRequestId === ucsXRequestId) {
              console.log(`🚀 Sending immediate response to UCS for ${xRequestId} (x-request-id validated)`);
              matchingUCSRequest.responseObject
                .status(matchingUCSRequest.responseData.statusCode)
                .set(matchingUCSRequest.responseData.headers)
                .json(matchingUCSRequest.responseData.body);
              matchingUCSRequest.responseSent = true;
            } else {
              console.log(`❌ x-request-id mismatch! UCS: ${ucsXRequestId}, Response: ${responseXRequestId}`);
              matchingUCSRequest.responseObject
                .status(500)
                .json({ error: "Response x-request-id mismatch", ucsId: ucsXRequestId, responseId: responseXRequestId });
              matchingUCSRequest.responseSent = true;
            }
          }
          
          console.log(`🎯 Pair ready for comparison in UI: ${pairId}`);
          
        } else {
          console.log(`⚠️ No matching UCS request found for x-request-id: ${xRequestId}`);
          
          // Debug: Show available UCS requests
          const ucsRequests = paymentRequests.filter(r => r.source === 'UCS' && !r.paired);
          console.log(`🔍 Available UCS requests:`, ucsRequests.map(r => r.headers['x-request-id']));
        }
        
      } else {
        console.log(`⚠️ REQUEST-RESPONSE PAIR missing x-request-id in nested headers`);
      }
      
    } catch (error) {
      console.log(`❌ Error parsing REQUEST-RESPONSE PAIR: ${error.message}`);
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log(`INCOMING: ${messageType}`);
  console.log(`Method: ${req.method} | URL: ${req.url}`);
  console.log(`Timestamp: ${timestamp}`);
  console.log('='.repeat(50));
  
  console.log('\nHEADERS:');
  console.log(JSON.stringify(req.headers, null, 2));
  
  console.log('\nBODY:');
  console.log(JSON.stringify(req.body, null, 2));
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  res.status(200).json({
    message: `${messageType} received and logged successfully`,
    timestamp,
    method: req.method,
    path: req.path,
    detectedType: messageType
  });
});

// API endpoints for the web UI
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/pairs', (req, res) => {
  // Clean the pairs data to remove circular references
  const cleanPairs = requestPairs.map(pair => ({
    ...pair,
    request1: pair.request1 ? {
      ...pair.request1,
      responseObject: undefined  // Remove circular reference
    } : pair.request1,
    request2: pair.request2 ? {
      ...pair.request2,
      responseObject: undefined  // Remove circular reference
    } : pair.request2
  }));
  res.json(cleanPairs);
});

app.get('/api/pairs/:id', (req, res) => {
  const pair = requestPairs.find(p => p.id === req.params.id);
  if (!pair) {
    return res.status(404).json({ error: 'Pair not found' });
  }
  res.json(pair);
});

app.post('/api/pairs/:id/compare', (req, res) => {
  const pair = requestPairs.find(p => p.id === req.params.id);
  if (!pair) {
    return res.status(404).json({ error: 'Pair not found' });
  }
  
  // Mark as compared
  pair.compared = true;
  
  // Generate comparison report
  const comparison = generateRequestComparisonReport(pair.request1, pair.request2);
  
  res.json({
    pair,
    comparison,
    comparedAt: new Date().toISOString()
  });
});

// Clear all data endpoints
app.delete('/api/clear', (req, res) => {
  paymentRequests.length = 0;
  requestPairs.length = 0;
  pendingRequestsByRequestId.clear();
  allMessages.length = 0; // Clear analysis messages too
  console.log('🧹 All data cleared (including analysis messages)');
  res.json({ 
    message: 'All data cleared successfully',
    timestamp: new Date().toISOString()
  });
});

app.delete('/api/pairs/clear', (req, res) => {
  requestPairs.length = 0;
  pendingRequestsByRequestId.clear();
  // Reset paired status for all requests
  paymentRequests.forEach(req => req.paired = false);
  console.log('🧹 All pairs cleared, requests available for re-pairing');
  res.json({ 
    message: 'All pairs cleared successfully',
    timestamp: new Date().toISOString()
  });
});

// Get storage stats
app.get('/api/stats', (req, res) => {
  res.json({
    totalRequests: paymentRequests.length,
    totalPairs: requestPairs.length,
    unpairedRequests: paymentRequests.filter(req => !req.paired).length,
    comparedPairs: requestPairs.filter(p => p.compared).length
  });
});

// Redis API endpoints
app.get('/api/redis/requests', async (req, res) => {
  try {
    const allRequests = await getAllStoredRequestsFromRedis();
    res.json({
      total: allRequests.length,
      requests: allRequests
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve requests from Redis' });
  }
});

app.get('/api/redis/requests/:requestId', async (req, res) => {
  try {
    const data = await getRequestResponseFromRedis(req.params.requestId);
    if (data) {
      res.json(data);
    } else {
      res.status(404).json({ error: 'Request not found in Redis' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve request from Redis' });
  }
});

app.delete('/api/redis/clear', async (req, res) => {
  try {
    const keys = await redisClient.keys('req:*');
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    res.json({ 
      message: `Cleared ${keys.length} requests from Redis`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear Redis data' });
  }
});

// Get all captured messages for analysis
app.get('/api/messages', (req, res) => {
  res.json({
    totalMessages: allMessages.length,
    messages: allMessages,
    analysis: {
      messagesWithXSource: allMessages.filter(m => m.hasXSource).length,
      messagesWithoutXSource: allMessages.filter(m => !m.hasXSource).length,
      messageTypes: [...new Set(allMessages.map(m => m.type))],
      uniqueRequestIds: [...new Set(allMessages.map(m => m.xRequestIdValue).filter(Boolean))],
      sourceDistribution: {
        UCS: allMessages.filter(m => m.source === 'UCS').length,
        HyperSwitch: allMessages.filter(m => m.source === 'HyperSwitch').length
      }
    }
  });
});

function generateRequestComparisonReport(request1, request2) {
  const report = {
    summary: {
      request1Timestamp: request1.timestamp,
      request2Timestamp: request2.timestamp,
      timeDifference: new Date(request2.timestamp) - new Date(request1.timestamp),
      totalFields: 0,
      matchingFields: 0,
      differentFields: 0,
      onlyInRequest1: 0,
      onlyInRequest2: 0,
      identical: false
    },
    metadata: {
      method: { request1: request1.method, request2: request2.method, match: request1.method === request2.method },
      url: { request1: request1.url, request2: request2.url, match: true }, // Always ignore URL differences
      type: { request1: request1.type, request2: request2.type, match: true } // Always ignore Type differences
    },
    headers: {
      differences: [],
      onlyInRequest1: [],
      onlyInRequest2: [],
      matching: []
    },
    body: {
      differences: [],
      onlyInRequest1: [],
      onlyInRequest2: []
    },
    visualAnalysis: {
      ucsFields: {
        missing: [], // Fields in HyperSwitch but not in UCS (red)
        extra: [],   // Fields in UCS but not in HyperSwitch (green)
        different: [], // Fields with different values (yellow)
        matching: []  // Fields with same values (neutral)
      },
      hyperSwitchFields: {
        missing: [], // Fields in UCS but not in HyperSwitch (red)
        extra: [],   // Fields in HyperSwitch but not in UCS (green)
        different: [], // Fields with different values (yellow)
        matching: []  // Fields with same values (neutral)
      }
    }
  };
  
  // Compare headers
  const headerComparison = deepCompare(request1.headers, request2.headers, 'headers');
  report.headers.differences = headerComparison.differences;
  report.headers.onlyInRequest1 = headerComparison.onlyInFirst;
  report.headers.onlyInRequest2 = headerComparison.onlyInSecond;
  
  // Identify matching headers (excluding ignored fields)
  const ignoredFields = ['x-request-id', 'x-connector', 'x-flow', 'x-source', 'connection', 'user-agent', 'accept', 'accept-encoding', 'host'];
  Object.keys(request1.headers || {}).forEach(key => {
    if (!ignoredFields.includes(key) && (request2.headers || {})[key] === request1.headers[key]) {
      report.headers.matching.push({
        name: key,
        value: request1.headers[key]
      });
    }
  });
  
  // Compare bodies
  const bodyComparison = deepCompare(request1.body, request2.body, 'body');
  report.body.differences = bodyComparison.differences;
  report.body.onlyInRequest1 = bodyComparison.onlyInFirst;
  report.body.onlyInRequest2 = bodyComparison.onlyInSecond;
  
  // Calculate totals
  const headerFields = headerComparison.totalFields;
  const bodyFields = bodyComparison.totalFields;
  const metadataFields = 3; // method, url, type
  
  report.summary.totalFields = headerFields + bodyFields + metadataFields;
  report.summary.matchingFields = headerComparison.matchingFields + bodyComparison.matchingFields + 
    (report.metadata.method.match ? 1 : 0) + 
    (report.metadata.url.match ? 1 : 0) + 
    (report.metadata.type.match ? 1 : 0);
  
  report.summary.differentFields = headerComparison.differences.length + bodyComparison.differences.length +
    (!report.metadata.method.match ? 1 : 0) + 
    (!report.metadata.url.match ? 1 : 0) + 
    (!report.metadata.type.match ? 1 : 0);
  
  report.summary.onlyInRequest1 = headerComparison.onlyInFirst.length + bodyComparison.onlyInFirst.length;
  report.summary.onlyInRequest2 = headerComparison.onlyInSecond.length + bodyComparison.onlyInSecond.length;
  
  // Calculate match percentage
  report.summary.matchPercentage = report.summary.totalFields > 0 ? 
    Math.round((report.summary.matchingFields / report.summary.totalFields) * 100) : 0;
  
  // Check if requests are identical
  report.summary.identical = report.summary.differentFields === 0 && 
                           report.summary.onlyInRequest1 === 0 && 
                           report.summary.onlyInRequest2 === 0;
  
  // Add detailed section breakdowns
  report.sectionSummary = {
    metadata: {
      total: metadataFields,
      matching: (report.metadata.method.match ? 1 : 0) + (report.metadata.url.match ? 1 : 0) + (report.metadata.type.match ? 1 : 0),
      different: (!report.metadata.method.match ? 1 : 0) + (!report.metadata.url.match ? 1 : 0) + (!report.metadata.type.match ? 1 : 0)
    },
    headers: {
      total: headerFields,
      matching: headerComparison.matchingFields,
      different: headerComparison.differences.length,
      onlyInFirst: headerComparison.onlyInFirst.length,
      onlyInSecond: headerComparison.onlyInSecond.length
    },
    body: {
      total: bodyFields,
      matching: bodyComparison.matchingFields,
      different: bodyComparison.differences.length,
      onlyInFirst: bodyComparison.onlyInFirst.length,
      onlyInSecond: bodyComparison.onlyInSecond.length
    }
  };
  
  // Generate visual analysis for UCS vs HyperSwitch
  // Assuming request1 is UCS and request2 is HyperSwitch
  const isUcsFirst = request1.source === 'UCS';
  const ucsRequest = isUcsFirst ? request1 : request2;
  const hsRequest = isUcsFirst ? request2 : request1;
  
  // Combine all comparison data for visual analysis
  const allDifferences = [...headerComparison.differences, ...bodyComparison.differences];
  const allOnlyInUcs = isUcsFirst ? [...headerComparison.onlyInFirst, ...bodyComparison.onlyInFirst] : [...headerComparison.onlyInSecond, ...bodyComparison.onlyInSecond];
  const allOnlyInHs = isUcsFirst ? [...headerComparison.onlyInSecond, ...bodyComparison.onlyInSecond] : [...headerComparison.onlyInFirst, ...bodyComparison.onlyInFirst];
  
  // Populate visual analysis
  allDifferences.forEach(diff => {
    const fieldInfo = {
      path: diff.path,
      ucsValue: isUcsFirst ? diff.request1 : diff.request2,
      hsValue: isUcsFirst ? diff.request2 : diff.request1,
      type: diff.type
    };
    report.visualAnalysis.ucsFields.different.push(fieldInfo);
    report.visualAnalysis.hyperSwitchFields.different.push(fieldInfo);
  });
  
  allOnlyInUcs.forEach(field => {
    const fieldInfo = {
      path: field.path,
      value: field.value,
      type: field.type
    };
    report.visualAnalysis.ucsFields.extra.push(fieldInfo);
    report.visualAnalysis.hyperSwitchFields.missing.push(fieldInfo);
  });
  
  allOnlyInHs.forEach(field => {
    const fieldInfo = {
      path: field.path,
      value: field.value,
      type: field.type
    };
    report.visualAnalysis.hyperSwitchFields.extra.push(fieldInfo);
    report.visualAnalysis.ucsFields.missing.push(fieldInfo);
  });
  
  // Add matching fields
  report.headers.matching.forEach(header => {
    const fieldInfo = {
      path: `headers.${header.name}`,
      value: header.value
    };
    report.visualAnalysis.ucsFields.matching.push(fieldInfo);
    report.visualAnalysis.hyperSwitchFields.matching.push(fieldInfo);
  });
  
  return report;
}

function deepCompare(obj1, obj2, path) {
  const result = {
    differences: [],
    onlyInFirst: [],
    onlyInSecond: [],
    totalFields: 0,
    matchingFields: 0
  };
  
  // Fields to ignore in comparison
  const ignoredFields = ['x-request-id', 'x-connector', 'x-flow', 'x-source', 'connection', 'user-agent', 'accept', 'accept-encoding', 'host'];
  
  // Get all unique keys from both objects, excluding ignored fields
  const allKeys = new Set([
    ...Object.keys(obj1 || {}).filter(key => !ignoredFields.includes(key)),
    ...Object.keys(obj2 || {}).filter(key => !ignoredFields.includes(key))
  ]);
  
  for (const key of allKeys) {
    const currentPath = path ? `${path}.${key}` : key;
    const val1 = obj1?.[key];
    const val2 = obj2?.[key];
    
    result.totalFields++;
    
    // Check if key exists in both objects
    if (!(key in (obj1 || {}))) {
      result.onlyInSecond.push({
        path: currentPath,
        value: val2,
        type: typeof val2
      });
      continue;
    }
    
    if (!(key in (obj2 || {}))) {
      result.onlyInFirst.push({
        path: currentPath,
        value: val1,
        type: typeof val1
      });
      continue;
    }
    
    // Both objects have the key, now compare values
    if (val1 === null && val2 === null) {
      result.matchingFields++;
    } else if (val1 === null || val2 === null) {
      result.differences.push({
        path: currentPath,
        request1: val1,
        request2: val2,
        type: 'null_mismatch'
      });
    } else if (typeof val1 !== typeof val2) {
      result.differences.push({
        path: currentPath,
        request1: val1,
        request2: val2,
        type: 'type_mismatch',
        type1: typeof val1,
        type2: typeof val2
      });
    } else if (typeof val1 === 'object' && typeof val2 === 'object') {
      // Recursively compare objects
      if (Array.isArray(val1) && Array.isArray(val2)) {
        // Compare arrays
        const arrayComparison = compareArrays(val1, val2, currentPath);
        result.differences.push(...arrayComparison.differences);
        result.onlyInFirst.push(...arrayComparison.onlyInFirst);
        result.onlyInSecond.push(...arrayComparison.onlyInSecond);
        result.totalFields += arrayComparison.totalFields;
        result.matchingFields += arrayComparison.matchingFields;
      } else if (!Array.isArray(val1) && !Array.isArray(val2)) {
        // Compare objects
        const nestedComparison = deepCompare(val1, val2, currentPath);
        result.differences.push(...nestedComparison.differences);
        result.onlyInFirst.push(...nestedComparison.onlyInFirst);
        result.onlyInSecond.push(...nestedComparison.onlyInSecond);
        result.totalFields += nestedComparison.totalFields;
        result.matchingFields += nestedComparison.matchingFields;
      } else {
        // One is array, one is object
        result.differences.push({
          path: currentPath,
          request1: Array.isArray(val1) ? '[Array]' : '[Object]',
          request2: Array.isArray(val2) ? '[Array]' : '[Object]',
          type: 'structure_mismatch'
        });
      }
    } else {
      // Compare primitive values
      if (val1 === val2) {
        result.matchingFields++;
      } else {
        result.differences.push({
          path: currentPath,
          request1: val1,
          request2: val2,
          type: 'value_mismatch'
        });
      }
    }
  }
  
  return result;
}

function compareArrays(arr1, arr2, path) {
  const result = {
    differences: [],
    onlyInFirst: [],
    onlyInSecond: [],
    totalFields: 0,
    matchingFields: 0
  };
  
  const maxLength = Math.max(arr1.length, arr2.length);
  result.totalFields = maxLength;
  
  for (let i = 0; i < maxLength; i++) {
    const currentPath = `${path}[${i}]`;
    
    if (i >= arr1.length) {
      result.onlyInSecond.push({
        path: currentPath,
        value: arr2[i],
        type: typeof arr2[i]
      });
    } else if (i >= arr2.length) {
      result.onlyInFirst.push({
        path: currentPath,
        value: arr1[i],
        type: typeof arr1[i]
      });
    } else {
      // Both arrays have element at index i
      const val1 = arr1[i];
      const val2 = arr2[i];
      
      if (typeof val1 === 'object' && typeof val2 === 'object') {
        if (val1 === null && val2 === null) {
          result.matchingFields++;
        } else if (val1 === null || val2 === null) {
          result.differences.push({
            path: currentPath,
            request1: val1,
            request2: val2,
            type: 'null_mismatch'
          });
        } else {
          const nestedComparison = deepCompare(val1, val2, currentPath);
          result.differences.push(...nestedComparison.differences);
          result.onlyInFirst.push(...nestedComparison.onlyInFirst);
          result.onlyInSecond.push(...nestedComparison.onlyInSecond);
          result.totalFields += nestedComparison.totalFields;
          result.matchingFields += nestedComparison.matchingFields;
        }
      } else {
        if (val1 === val2) {
          result.matchingFields++;
        } else {
          result.differences.push({
            path: currentPath,
            request1: val1,
            request2: val2,
            type: 'value_mismatch'
          });
        }
      }
    }
  }
  
  return result;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📨 Ready to receive requests on http://localhost:${PORT}/receive`);
  console.log(`🌐 Web UI available at http://localhost:${PORT}`);
  console.log('🔍 All request details will be logged to console');
});