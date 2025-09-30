# Hyperswitch → UCS Testing

This guide explains how to set up and test Hyperswitch with UCS using a proxy.

---

## Prerequisites

- [Node.js](https://nodejs.org/) (with npm)
- [Homebrew](https://brew.sh/) (for macOS users, to install mitmproxy)

---

## Setup Instructions

### 1. Apply Branch Changes
Make sure you apply the changes from https://github.com/juspay/hyperswitch/tree/diff-fork to your local copy of Hyperswitch.
Make sure you apply the changes form https://github.com/juspay/connector-service/tree/shadow-ucs-diff to your local copy of UCS

### 2. Install Dependencies
Install required Node.js dependencies:
```bash
npm i
```

Run server
```bash
npm start
```

### 3. Initialize Mitmproxy
```bash
brew install mitmproxy
```
```bash
mitmweb -s ~/Documents/<your-folder-name>/forward_code2.py --listen-port 8081 --web-port 8082
```

what the process of testing 
1) send a req from hyperswitch using postman and see mitmproxy at port localhost:8082 and then you can see the req-diff on localhost:9000
