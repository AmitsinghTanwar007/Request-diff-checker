#!/usr/bin/env node

const axios = require('axios');
const { diffLines } = require('diff');

class RequestDiffChecker {
  constructor() {
    this.responses = new Map();
  }

  async makeRequest(url, options = {}) {
    try {
      const response = await axios({
        url,
        ...options
      });
      
      return {
        status: response.status,
        headers: response.headers,
        data: response.data
      };
    } catch (error) {
      return {
        error: error.message,
        status: error.response?.status || 'Network Error',
        data: error.response?.data || null
      };
    }
  }

  async checkDiff(url1, url2, options1 = {}, options2 = {}) {
    console.log(`Making request to: ${url1}`);
    const response1 = await this.makeRequest(url1, options1);
    
    console.log(`Making request to: ${url2}`);
    const response2 = await this.makeRequest(url2, options2);

    // Store responses for future reference
    this.responses.set('first', response1);
    this.responses.set('second', response2);

    // Compare responses
    const diff = this.compareResponses(response1, response2);
    
    return {
      response1,
      response2,
      diff
    };
  }

  compareResponses(resp1, resp2) {
    const json1 = JSON.stringify(resp1, null, 2);
    const json2 = JSON.stringify(resp2, null, 2);
    
    const diff = diffLines(json1, json2);
    
    console.log('\n=== DIFF RESULTS ===');
    diff.forEach((part) => {
      const color = part.added ? '\x1b[32m' : part.removed ? '\x1b[31m' : '\x1b[0m';
      const prefix = part.added ? '+' : part.removed ? '-' : ' ';
      const lines = part.value.split('\n');
      
      lines.forEach(line => {
        if (line.trim()) {
          console.log(`${color}${prefix} ${line}\x1b[0m`);
        }
      });
    });
    
    return diff;
  }

  printHelp() {
    console.log(`
Request Diff Checker
===================

Usage: node index.js [URL1] [URL2]

Examples:
  node index.js https://api.example.com/users/1 https://api.example.com/users/2
  node index.js https://httpbin.org/json https://httpbin.org/uuid

This tool makes HTTP requests to two URLs and shows the differences between their responses.
    `);
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    const checker = new RequestDiffChecker();
    checker.printHelp();
    return;
  }

  if (args.length < 2) {
    console.error('Error: Please provide two URLs to compare');
    console.log('Use --help for usage information');
    process.exit(1);
  }

  const [url1, url2] = args;
  const checker = new RequestDiffChecker();

  try {
    console.log('Request Diff Checker - Starting comparison...\n');
    
    const result = await checker.checkDiff(url1, url2);
    
    console.log('\n=== SUMMARY ===');
    console.log(`URL 1 Status: ${result.response1.status}`);
    console.log(`URL 2 Status: ${result.response2.status}`);
    
    const hasChanges = result.diff.some(part => part.added || part.removed);
    console.log(`Differences found: ${hasChanges ? 'YES' : 'NO'}`);
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = RequestDiffChecker;