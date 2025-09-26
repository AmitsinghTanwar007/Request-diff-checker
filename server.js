const express = require('express');
const path = require('path');
const app = express();
const PORT = 9000;

// Store for payment requests
const paymentRequests = [];
const requestPairs = []; // Store pairs of requests for comparison
const pendingRequestsByRequestId = new Map(); // Store requests waiting for their pair by x-request-id

// Temporary storage for all messages (for analysis)
const allMessages = [];

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

function detectRequestSource(headers) {
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

app.all('/receive', (req, res) => {
  const messageType = detectMessageType(req.body, req.headers, req.method);
  const typeEmoji = messageType === 'REQUEST' ? '📤' : 
                   messageType === 'RESPONSE' ? '📥' : 
                   messageType === 'PAYMENT REQUEST' ? '💳' :
                   messageType === 'WEBHOOK/RESPONSE' ? '🔔' :
                   messageType === 'REQUEST-RESPONSE PAIR' ? '🔄' : '❓';
  
  const timestamp = new Date().toISOString();
  const isHyperSwitch = req.headers.via === 'HyperSwitch';
  
  // ENHANCED LOGGING: Capture all HyperSwitch messages for analysis
  if (isHyperSwitch) {
    const xSource = req.headers['x-source'];
    const xRequestId = req.headers['x-request-id'];
    const xConnector = req.headers['x-connector'];
    const xFlow = req.headers['x-flow'];
    
    console.log('\n' + '🔍'.repeat(80));
    console.log('🔍 ENHANCED ANALYSIS LOGGING');
    console.log('🔍'.repeat(80));
    console.log(`🔍 Message Type Detected: ${messageType}`);
    console.log(`🔍 x-source: ${xSource || 'NOT PRESENT'}`);
    console.log(`🔍 x-request-id: ${xRequestId || 'NOT PRESENT'}`);
    console.log(`🔍 x-connector: ${xConnector || 'NOT PRESENT'}`);
    console.log(`🔍 x-flow: ${xFlow || 'NOT PRESENT'}`);
    console.log(`🔍 via: ${req.headers.via || 'NOT PRESENT'}`);
    console.log(`🔍 Content-Type: ${req.headers['content-type'] || 'NOT PRESENT'}`);
    console.log(`🔍 Method: ${req.method}`);
    console.log(`🔍 URL: ${req.url}`);
    
    // Store ALL HyperSwitch messages temporarily for analysis
    const messageData = {
      id: generateRequestId(req.body, req.headers),
      timestamp,
      type: messageType,
      headers: req.headers,
      body: req.body,
      method: req.method,
      url: req.url,
      source: detectRequestSource(req.headers),
      paired: false,
      // Analysis fields
      hasXSource: !!xSource,
      xSourceValue: xSource,
      hasXRequestId: !!xRequestId,
      xRequestIdValue: xRequestId
    };
    
    allMessages.push(messageData);
    console.log(`🔍 Stored in allMessages array. Total messages: ${allMessages.length}`);
    console.log(`🔍 Source detected as: ${messageData.source}`);
    console.log('🔍'.repeat(80) + '\n');
  }
  
  // Store payment requests logic - only for HyperSwitch payment requests
  if (isHyperSwitch && messageType === 'PAYMENT REQUEST') {
    const requestId = generateRequestId(req.body, req.headers);
    const source = detectRequestSource(req.headers);
    
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
    console.log(`📝 Stored payment request with ID: ${requestId} from ${source}`);
    console.log(`📊 Total requests stored: ${paymentRequests.length}`);
    
    // ONLY create pairs based on x-request-id matching
    const newPair = createRequestPairByRequestId(requestData);
    
    if (newPair) {
      console.log(`🎯 New pair available for comparison: ${newPair.id}`);
    }
  }
  
  console.log('\n' + '='.repeat(80));
  console.log(`${typeEmoji} INCOMING ${messageType}`);
  console.log('='.repeat(80));
  
  console.log(`🕒 Timestamp: ${timestamp}`);
  console.log(`🌐 Method: ${req.method}`);
  console.log(`📍 URL: ${req.url}`);
  console.log(`🔗 Original URL: ${req.originalUrl}`);
  console.log(`📡 Protocol: ${req.protocol}`);
  console.log(`🏠 Host: ${req.get('host')}`);
  console.log(`🛣️  Path: ${req.path}`);
  console.log(`🏷️  Detected Type: ${messageType}`);
  console.log(`🔄 Via HyperSwitch: ${isHyperSwitch ? 'Yes' : 'No'}`);
  
  console.log('\n📋 HEADERS:');
  console.log('-'.repeat(40));
  Object.entries(req.headers).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`);
  });
  
  console.log('\n🔍 QUERY PARAMETERS:');
  console.log('-'.repeat(40));
  if (Object.keys(req.query).length > 0) {
    Object.entries(req.query).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
  } else {
    console.log('  (none)');
  }
  
  console.log('\n📦 BODY:');
  console.log('-'.repeat(40));
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(JSON.stringify(req.body, null, 2));
  } else if (req.body) {
    console.log(req.body);
  } else {
    console.log('  (empty)');
  }
  
  console.log('\n🌍 CLIENT INFO:');
  console.log('-'.repeat(40));
  console.log(`  IP: ${req.ip}`);
  console.log(`  User-Agent: ${req.get('User-Agent') || 'Unknown'}`);
  console.log(`  Content-Type: ${req.get('Content-Type') || 'Not specified'}`);
  console.log(`  Content-Length: ${req.get('Content-Length') || 'Not specified'}`);
  
  console.log('\n' + '='.repeat(80));
  console.log(`✅ ${messageType} LOGGED`);
  console.log('='.repeat(80) + '\n');
  
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
  res.json(requestPairs);
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
      url: { request1: request1.url, request2: request2.url, match: request1.url === request2.url },
      type: { request1: request1.type, request2: request2.type, match: request1.type === request2.type }
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
  const ignoredFields = ['x-request-id', 'x-connector', 'x-flow', 'x-source'];
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
  const ignoredFields = ['x-request-id', 'x-connector', 'x-flow', 'x-source'];
  
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